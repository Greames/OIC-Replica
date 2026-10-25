import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { nextRunAfter } from "../schedule.js";
import { type InstanceStatus, instanceSteps, instances, integrations, schedules } from "../schema/runtime.js";
import { type Actor, assertCan, NotFoundError } from "./access.js";
import { emitEvent } from "./events.js";

export type Instance = typeof instances.$inferSelect;
export type InstanceStep = typeof instanceSteps.$inferSelect;

/** Creates a queued run. With an idempotency key, a repeat returns the first run. */
export async function createInstance(
  db: Db,
  args: {
    orgId: string;
    integration: { id: string; version: string; definitionHash: string };
    triggerKind: Instance["triggerKind"];
    input: unknown;
    idempotencyKey?: string | null;
    parentInstanceId?: string | null;
  },
): Promise<{ instance: Instance; duplicate: boolean }> {
  const [row] = await db
    .insert(instances)
    .values({
      orgId: args.orgId,
      integrationId: args.integration.id,
      integrationVersion: args.integration.version,
      definitionHash: args.integration.definitionHash,
      triggerKind: args.triggerKind,
      input: args.input ?? null,
      idempotencyKey: args.idempotencyKey ?? null,
      parentInstanceId: args.parentInstanceId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { instance: row, duplicate: false };
  const [existing] = await db
    .select()
    .from(instances)
    .where(
      and(eq(instances.integrationId, args.integration.id), eq(instances.idempotencyKey, args.idempotencyKey ?? "")),
    );
  if (!existing) throw new Error("Could not create the instance.");
  return { instance: existing, duplicate: true };
}

export interface InstanceFilter {
  integrationId?: string;
  status?: InstanceStatus;
  businessId?: string;
  /** Opaque cursor from the previous page. */
  before?: string;
  limit?: number;
}

/** S21. Newest first, keyset-paginated. */
export async function listInstances(db: Db, actor: Actor, f: InstanceFilter = {}) {
  assertCan(actor, "read");
  const limit = Math.min(f.limit ?? 50, 200);
  let cursor: { at: Date; id: string } | undefined;
  if (f.before) {
    const [at, id] = Buffer.from(f.before, "base64url").toString().split("|");
    if (at && id) cursor = { at: new Date(at), id };
  }
  const rows = await db
    .select({
      id: instances.id,
      status: instances.status,
      triggerKind: instances.triggerKind,
      primaryBusinessId: instances.primaryBusinessId,
      errorCode: instances.errorCode,
      errorMessage: instances.errorMessage,
      createdAt: instances.createdAt,
      startedAt: instances.startedAt,
      durationMs: instances.durationMs,
      integrationId: instances.integrationId,
      integrationName: integrations.name,
      integrationIdentifier: integrations.identifier,
      integrationVersion: instances.integrationVersion,
    })
    .from(instances)
    .innerJoin(integrations, eq(integrations.id, instances.integrationId))
    .where(
      and(
        eq(instances.orgId, actor.orgId),
        f.integrationId ? eq(instances.integrationId, f.integrationId) : undefined,
        f.status ? eq(instances.status, f.status) : undefined,
        f.businessId ? eq(instances.primaryBusinessId, f.businessId) : undefined,
        cursor
          ? or(lt(instances.createdAt, cursor.at), and(eq(instances.createdAt, cursor.at), lt(instances.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(desc(instances.createdAt), desc(instances.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next =
    rows.length > limit && last
      ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url")
      : null;
  return { items: page, next };
}

/** S22. The run with its activity stream. */
export async function getInstance(db: Db, actor: Actor, id: string) {
  assertCan(actor, "read");
  const [row] = await db
    .select({
      instance: instances,
      integrationName: integrations.name,
      integrationIdentifier: integrations.identifier,
      tracingLevel: integrations.tracingLevel,
    })
    .from(instances)
    .innerJoin(integrations, eq(integrations.id, instances.integrationId))
    .where(and(eq(instances.orgId, actor.orgId), eq(instances.id, id)));
  if (!row) throw new NotFoundError("Run");
  const steps = await db
    .select()
    .from(instanceSteps)
    .where(eq(instanceSteps.instanceId, id))
    .orderBy(asc(instanceSteps.seq));
  return {
    ...row.instance,
    integrationName: row.integrationName,
    integrationIdentifier: row.integrationIdentifier,
    tracingLevel: row.tracingLevel,
    steps,
  };
}

/** Claims a queued run for execution. Returns null if another worker got it. */
export async function startInstance(db: Db, id: string): Promise<Instance | null> {
  const [row] = await db
    .update(instances)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(instances.id, id), eq(instances.status, "queued")))
    .returning();
  return row ?? null;
}

export async function appendStep(
  db: Db,
  instanceId: string,
  step: Omit<typeof instanceSteps.$inferInsert, "instanceId">,
) {
  await db
    .insert(instanceSteps)
    .values({ ...step, instanceId })
    .onConflictDoNothing();
}

export async function finishInstance(
  db: Db,
  id: string,
  r: {
    status: "succeeded" | "failed" | "aborted";
    output?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    businessIds?: Record<string, string>;
    primaryBusinessId?: string | null;
  },
): Promise<Instance> {
  const ended = new Date();
  const [row] = await db
    .update(instances)
    .set({
      status: r.status,
      output: r.output ?? null,
      errorCode: r.errorCode ?? null,
      errorMessage: r.errorMessage ?? null,
      businessIds: r.businessIds ?? {},
      primaryBusinessId: r.primaryBusinessId ?? null,
      endedAt: ended,
      durationMs: sql`(extract(epoch from (${ended.toISOString()}::timestamptz - coalesce(${instances.startedAt}, ${instances.createdAt}))) * 1000)::int`,
    })
    .where(eq(instances.id, id))
    .returning();
  const run = row!;
  const [integ] = await db
    .select({ name: integrations.name })
    .from(integrations)
    .where(eq(integrations.id, run.integrationId));
  const name = integ?.name ?? "An integration";
  const bid = run.primaryBusinessId ? ` (${run.primaryBusinessId})` : "";
  await emitEvent(db, {
    orgId: run.orgId,
    type: run.status === "succeeded" ? "instance.succeeded" : "instance.failed",
    severity: run.status === "succeeded" ? "info" : "error",
    subjectType: "instance",
    subjectId: run.id,
    summary:
      run.status === "succeeded"
        ? `"${name}" ran successfully${bid} in ${run.durationMs ?? 0} ms.`
        : `"${name}" failed${bid}: ${run.errorMessage ?? run.errorCode ?? "unknown error"}`,
    path: `/observability/runs/${run.id}`,
    data: {
      integrationId: run.integrationId,
      trigger: run.triggerKind,
      errorCode: run.errorCode,
      businessId: run.primaryBusinessId,
      durationMs: run.durationMs,
    },
  });
  return run;
}

/** Runs left "running" by a crashed worker: mark them failed so they can be resubmitted. */
export async function failStaleInstances(db: Db, olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .update(instances)
    .set({
      status: "failed",
      errorCode: "worker_lost",
      errorMessage: "The worker running this stopped before it finished. Resubmit it to run again.",
      endedAt: new Date(),
    })
    .where(and(eq(instances.status, "running"), lt(instances.startedAt, cutoff)))
    .returning({ id: instances.id });
  return rows.length;
}

/**
 * Claims schedules that are due and moves them to their next run, in one
 * transaction with SKIP LOCKED so several workers never fire the same one.
 * Returns the integrations to run. Overlap: skipped if a run is still active.
 */
export async function claimDueSchedules(db: Db, now = new Date(), limit = 50) {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ schedule: schedules, integration: integrations })
      .from(schedules)
      .innerJoin(integrations, eq(integrations.id, schedules.integrationId))
      .where(
        and(
          eq(schedules.status, "active"),
          eq(integrations.status, "active"),
          sql`${schedules.nextRunAt} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(schedules.nextRunAt))
      .limit(limit)
      .for("update", { of: schedules, skipLocked: true });
    if (due.length === 0) return [];

    const busy = new Set(
      (
        await tx
          .select({ id: instances.integrationId })
          .from(instances)
          .where(
            and(
              inArray(
                instances.integrationId,
                due.filter((d) => !d.schedule.allowOverlap).map((d) => d.integration.id),
              ),
              inArray(instances.status, ["queued", "running"]),
            ),
          )
      ).map((r) => r.id),
    );

    const fire: { integration: typeof integrations.$inferSelect; scheduledFor: Date; skipped: boolean }[] = [];
    for (const { schedule, integration } of due) {
      // Catch up to the next future slot; missed slots are not replayed.
      let next = nextRunAfter(schedule, schedule.nextRunAt ?? now);
      while (next <= now) next = nextRunAfter(schedule, next);
      await tx.update(schedules).set({ nextRunAt: next, lastRunAt: now }).where(eq(schedules.id, schedule.id));
      fire.push({ integration, scheduledFor: schedule.nextRunAt ?? now, skipped: busy.has(integration.id) });
    }
    return fire;
  });
}
