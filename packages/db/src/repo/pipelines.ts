import { type FlowDoc, walkSteps } from "@oicr/flow-schema";
import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { capPayload } from "../payload.js";
import { pipelineCheckpoints, pipelineRejects } from "../schema/pipelines.js";
import { instances, type RunLane } from "../schema/runtime.js";
import { asSystem, asTenant } from "../tenancy.js";
import { type Actor, assertCan } from "./access.js";

export type PipelineCheckpoint = typeof pipelineCheckpoints.$inferSelect;
export type PipelineReject = typeof pipelineRejects.$inferSelect;

/** Rejected records kept per pipeline step; beyond this only the count grows. */
export const MAX_STORED_REJECTS = 10_000;
const REJECT_RECORD_BYTES = 4 * 1024;

/** Flows with a pipeline run on the batch lane. */
export function laneFor(definition: unknown): RunLane {
  let lane: RunLane = "standard";
  try {
    walkSteps(definition as FlowDoc, ({ step }) => {
      if (step.type === "pipeline") lane = "batch";
    });
  } catch {
    // Not a valid document: it fails when it runs, on any lane.
  }
  return lane;
}

type Run = { id: string; orgId: string };

export async function loadCheckpoint(db: Db, run: Run, stepId: string): Promise<PipelineCheckpoint | null> {
  return asTenant(db, run.orgId, async (db) => {
    const [row] = await db
      .select()
      .from(pipelineCheckpoints)
      .where(and(eq(pipelineCheckpoints.instanceId, run.id), eq(pipelineCheckpoints.stepId, stepId)));
    return row ?? null;
  });
}

export interface CheckpointInput {
  cursor: unknown;
  read: number;
  written: number;
  filtered: number;
  rejected: number;
  chunks: number;
}

/** Saves progress after a chunk (and counts as the run's heartbeat). */
export async function saveCheckpoint(
  db: Db,
  run: Run,
  stepId: string,
  state: CheckpointInput,
  status: "running" | "done" = "running",
): Promise<void> {
  await asTenant(db, run.orgId, async (db) => {
    const values = {
      cursor: state.cursor ?? null,
      read: state.read,
      written: state.written,
      filtered: state.filtered,
      rejected: state.rejected,
      chunks: state.chunks,
      status,
    };
    await db
      .insert(pipelineCheckpoints)
      .values({ orgId: run.orgId, instanceId: run.id, stepId, ...values })
      .onConflictDoUpdate({ target: [pipelineCheckpoints.instanceId, pipelineCheckpoints.stepId], set: values });
    await db.update(instances).set({ heartbeatAt: new Date() }).where(eq(instances.id, run.id));
  });
}

export interface RejectInput {
  chunk: number;
  index: number;
  stage: "transform" | "write";
  code: string;
  message: string;
  record: Record<string, unknown>;
}

/** Stores rejected records (shortened), up to MAX_STORED_REJECTS per step. */
export async function recordRejects(db: Db, run: Run, stepId: string, rejects: RejectInput[]): Promise<void> {
  if (rejects.length === 0) return;
  await asTenant(db, run.orgId, async (db) => {
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pipelineRejects)
      .where(and(eq(pipelineRejects.instanceId, run.id), eq(pipelineRejects.stepId, stepId)))) as [{ n: number }];
    const room = Math.max(0, MAX_STORED_REJECTS - n);
    if (room === 0) return;
    await db.insert(pipelineRejects).values(
      rejects.slice(0, room).map((r) => ({
        orgId: run.orgId,
        instanceId: run.id,
        stepId,
        chunk: r.chunk,
        rowIndex: r.index,
        stage: r.stage,
        code: r.code.slice(0, 100),
        message: r.message.slice(0, 2000),
        record: capPayload(r.record, REJECT_RECORD_BYTES),
      })),
    );
  });
}

export async function heartbeat(db: Db, run: Run): Promise<void> {
  await asTenant(db, run.orgId, (db) =>
    db.update(instances).set({ heartbeatAt: new Date() }).where(eq(instances.id, run.id)),
  );
}

/** A run's pipeline progress, for the run page and the API. */
export async function listCheckpoints(db: Db, actor: Actor, instanceId: string): Promise<PipelineCheckpoint[]> {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "read");
    return db
      .select()
      .from(pipelineCheckpoints)
      .where(and(eq(pipelineCheckpoints.orgId, actor.orgId), eq(pipelineCheckpoints.instanceId, instanceId)));
  });
}

export async function listRejects(
  db: Db,
  actor: Actor,
  instanceId: string,
  opts: { stepId?: string; after?: number; limit?: number } = {},
): Promise<PipelineReject[]> {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "read");
    return db
      .select()
      .from(pipelineRejects)
      .where(
        and(
          eq(pipelineRejects.orgId, actor.orgId),
          eq(pipelineRejects.instanceId, instanceId),
          opts.stepId ? eq(pipelineRejects.stepId, opts.stepId) : undefined,
          opts.after ? gt(pipelineRejects.id, opts.after) : undefined,
        ),
      )
      .orderBy(asc(pipelineRejects.id))
      .limit(Math.min(opts.limit ?? 100, 1000));
  });
}

/**
 * Batch runs whose engine stopped (no heartbeat for `staleMs`) go back to the
 * queue to resume from their checkpoints, up to `maxAttempts`; then they fail.
 * Returns the runs to enqueue again.
 */
export async function requeueStaleBatchRuns(
  db: Db,
  staleMs: number,
  maxAttempts: number,
): Promise<{ requeued: Run[]; failed: number }> {
  return asSystem(db, "requeueStaleBatchRuns", async (db) => {
    const cutoff = new Date(Date.now() - staleMs);
    const stale = and(
      eq(instances.lane, "batch"),
      eq(instances.status, "running"),
      or(
        lt(instances.heartbeatAt, cutoff),
        and(sql`${instances.heartbeatAt} is null`, lt(instances.startedAt, cutoff)),
      ),
    );
    const failed = await db
      .update(instances)
      .set({
        status: "failed",
        errorCode: "worker_lost",
        errorMessage: `The batch engine stopped ${maxAttempts} times while running this. Resubmit it to try again.`,
        endedAt: new Date(),
      })
      .where(and(stale, sql`${instances.attempts} >= ${maxAttempts}`))
      .returning({ id: instances.id });
    const requeued = await db
      .update(instances)
      .set({ status: "queued", attempts: sql`${instances.attempts} + 1`, heartbeatAt: null })
      .where(stale)
      .returning({ id: instances.id, orgId: instances.orgId });
    return { requeued, failed: failed.length };
  });
}
