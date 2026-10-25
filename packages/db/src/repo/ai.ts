import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { aiChanges, aiMessages, aiSessions, type PendingQuestion } from "../schema/ai.js";
import { projects } from "../schema/core.js";
import { type Actor, assertCan, ConflictError, NotFoundError } from "./access.js";
import { createIntegration, getIntegration, InvalidStateError, saveDefinition, setSchedule } from "./integrations.js";

export type AiSession = typeof aiSessions.$inferSelect;
export type AiMessage = typeof aiMessages.$inferSelect;
export type AiChange = typeof aiChanges.$inferSelect;

export async function createAiSession(
  db: Db,
  actor: Actor,
  args: { projectId?: string | null; integrationId?: string | null; title: string },
): Promise<AiSession> {
  assertCan(actor, "build");
  let projectId = args.projectId ?? null;
  if (args.integrationId) {
    projectId = (await getIntegration(db, actor, args.integrationId)).projectId;
  }
  if (!projectId) throw new NotFoundError("Project");
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, projectId)));
  if (!project) throw new NotFoundError("Project");
  const [row] = await db
    .insert(aiSessions)
    .values({
      orgId: actor.orgId,
      userId: actor.userId,
      projectId,
      integrationId: args.integrationId ?? null,
      title: args.title.slice(0, 120),
    })
    .returning();
  return row!;
}

export async function getAiSession(db: Db, actor: Actor, id: string) {
  assertCan(actor, "read");
  const [session] = await db
    .select()
    .from(aiSessions)
    .where(and(eq(aiSessions.orgId, actor.orgId), eq(aiSessions.id, id)));
  if (!session) throw new NotFoundError("Conversation");
  const [messages, changes] = await Promise.all([
    db.select().from(aiMessages).where(eq(aiMessages.sessionId, id)).orderBy(asc(aiMessages.seq)),
    db.select().from(aiChanges).where(eq(aiChanges.sessionId, id)).orderBy(asc(aiChanges.createdAt)),
  ]);
  return { session, messages, changes };
}

export async function listAiSessions(db: Db, actor: Actor, opts: { integrationId?: string; limit?: number } = {}) {
  assertCan(actor, "read");
  return db
    .select()
    .from(aiSessions)
    .where(
      and(
        eq(aiSessions.orgId, actor.orgId),
        eq(aiSessions.userId, actor.userId),
        opts.integrationId ? eq(aiSessions.integrationId, opts.integrationId) : undefined,
      ),
    )
    .orderBy(desc(aiSessions.updatedAt))
    .limit(opts.limit ?? 20);
}

/** Takes the session for one turn. Only one turn runs at a time. */
export async function claimAiSession(db: Db, actor: Actor, id: string): Promise<AiSession> {
  assertCan(actor, "build");
  const [row] = await db
    .update(aiSessions)
    .set({ status: "running", lastError: null })
    .where(
      and(
        eq(aiSessions.orgId, actor.orgId),
        eq(aiSessions.id, id),
        inArray(aiSessions.status, ["idle", "waiting", "error"]),
      ),
    )
    .returning();
  if (row) return row;
  await getAiSession(db, actor, id); // 404 if it does not exist
  throw new ConflictError("The AI is still working on the last message.");
}

export async function releaseAiSession(
  db: Db,
  id: string,
  state: { status: "idle" | "waiting" | "error"; pending?: PendingQuestion | null; lastError?: string | null },
): Promise<void> {
  await db
    .update(aiSessions)
    .set({ status: state.status, pending: state.pending ?? null, lastError: state.lastError ?? null })
    .where(eq(aiSessions.id, id));
}

/** Sessions stuck in "running" (server restart mid-turn) become usable again. */
export async function recoverStuckAiSessions(db: Db, olderThanMs: number): Promise<number> {
  const rows = await db
    .update(aiSessions)
    .set({ status: "error", lastError: "The last answer was interrupted. Send your message again." })
    .where(
      and(
        eq(aiSessions.status, "running"),
        sql`${aiSessions.updatedAt} < now() - make_interval(secs => ${olderThanMs / 1000})`,
      ),
    )
    .returning({ id: aiSessions.id });
  return rows.length;
}

/** Appends to the conversation. Callers hold the session (claimAiSession), so seq cannot race. */
export async function appendAiMessage(
  db: Db,
  sessionId: string,
  msg: { role: "user" | "assistant"; content: unknown[]; model?: string; stopReason?: string | null; usage?: unknown },
): Promise<AiMessage> {
  const [row] = await db
    .insert(aiMessages)
    .values({
      sessionId,
      seq: sql`(select coalesce(max(${aiMessages.seq}), 0) + 1 from ${aiMessages} where ${aiMessages.sessionId} = ${sessionId})`,
      role: msg.role,
      content: msg.content,
      model: msg.model ?? null,
      stopReason: msg.stopReason ?? null,
      usage: msg.usage ?? null,
    })
    .returning();
  const usage = msg.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
    | undefined;
  await db
    .update(aiSessions)
    .set({
      inputTokens: sql`${aiSessions.inputTokens} + ${(usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0)}`,
      outputTokens: sql`${aiSessions.outputTokens} + ${usage?.output_tokens ?? 0}`,
    })
    .where(eq(aiSessions.id, sessionId));
  return row!;
}

/** Records a validated proposal. Earlier open proposals in the session go stale. */
export async function createAiChange(
  db: Db,
  args: Omit<
    typeof aiChanges.$inferInsert,
    "id" | "status" | "createdAt" | "decidedAt" | "decidedBy" | "resultIntegrationId"
  >,
): Promise<AiChange> {
  await db
    .update(aiChanges)
    .set({ status: "stale" })
    .where(and(eq(aiChanges.sessionId, args.sessionId), eq(aiChanges.status, "proposed")));
  const [row] = await db.insert(aiChanges).values(args).returning();
  return row!;
}

async function loadChange(db: Db, actor: Actor, id: string) {
  const [change] = await db
    .select()
    .from(aiChanges)
    .where(and(eq(aiChanges.orgId, actor.orgId), eq(aiChanges.id, id)));
  if (!change) throw new NotFoundError("Proposal");
  if (change.status !== "proposed") throw new InvalidStateError(`This proposal was already ${change.status}.`);
  return change;
}

/**
 * A person accepts a proposal (S29): it becomes a new integration or replaces
 * the definition of the existing one. Refused if the integration changed since
 * the AI read it, or if it is active.
 */
export async function acceptAiChange(db: Db, actor: Actor, id: string): Promise<{ integrationId: string }> {
  assertCan(actor, "build");
  const change = await loadChange(db, actor, id);
  const [session] = await db.select().from(aiSessions).where(eq(aiSessions.id, change.sessionId));
  if (!session) throw new NotFoundError("Conversation");

  let integrationId: string;
  if (change.integrationId) {
    const current = await getIntegration(db, actor, change.integrationId);
    if (current.status === "active")
      throw new InvalidStateError("Deactivate the integration before applying changes to it.");
    if (current.definitionHash !== change.baseHash) {
      await db.update(aiChanges).set({ status: "stale" }).where(eq(aiChanges.id, id));
      throw new ConflictError(
        "The integration changed after the AI read it. Ask the AI to try again on the latest version.",
      );
    }
    await saveDefinition(db, actor, current.id, change.proposedDefinition, current.definitionHash);
    integrationId = current.id;
  } else {
    const style =
      (change.proposedDefinition as { style?: string }).style === "application" ? "application" : "scheduled";
    let created: Awaited<ReturnType<typeof createIntegration>> | undefined;
    for (let n = 1; !created; n++) {
      try {
        created = await createIntegration(db, actor, {
          projectId: session.projectId,
          name: n === 1 ? change.name : `${change.name} ${n}`,
          style,
          definition: change.proposedDefinition,
        });
      } catch (e) {
        if (!(e instanceof ConflictError) || n >= 5) throw e;
      }
    }
    integrationId = created.id;
  }
  if (change.schedule) await setSchedule(db, actor, integrationId, change.schedule);

  await db
    .update(aiChanges)
    .set({ status: "accepted", decidedBy: actor.userId, decidedAt: new Date(), resultIntegrationId: integrationId })
    .where(eq(aiChanges.id, id));
  // Follow-up requests in this conversation now edit that integration.
  await db.update(aiSessions).set({ integrationId }).where(eq(aiSessions.id, session.id));
  return { integrationId };
}

export async function rejectAiChange(db: Db, actor: Actor, id: string): Promise<void> {
  assertCan(actor, "build");
  await loadChange(db, actor, id);
  await db
    .update(aiChanges)
    .set({ status: "rejected", decidedBy: actor.userId, decidedAt: new Date() })
    .where(eq(aiChanges.id, id));
}
