import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { deliveries, type EventType, events, notificationChannels, type Severity } from "../schema/events.js";
import { type Actor, assertCan } from "./access.js";

export type Event = typeof events.$inferSelect;

export interface NewEvent {
  orgId: string;
  type: EventType;
  severity?: Severity;
  subjectType: string;
  subjectId: string;
  summary: string;
  path?: string | null;
  data?: Record<string, unknown>;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

/** "*" | "instance.*" | "instance.failed" */
export function matchesPattern(type: string, patterns: string[]): boolean {
  return patterns.some((p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));
}

export const EVENTS_CHANNEL = "oicr_events";

/**
 * Writes an event, queues a delivery for every matching channel, and wakes
 * live listeners (LISTEN oicr_events). Pass a transaction to make the event
 * part of the change it describes.
 */
export async function recordEvent(db: Db, e: NewEvent): Promise<Event> {
  const [row] = await db
    .insert(events)
    .values({
      orgId: e.orgId,
      type: e.type,
      severity: e.severity ?? "info",
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      summary: e.summary.slice(0, 500),
      path: e.path ?? null,
      data: e.data ?? {},
    })
    .returning();
  const event = row!;
  const channels = await db
    .select({
      id: notificationChannels.id,
      eventTypes: notificationChannels.eventTypes,
      minSeverity: notificationChannels.minSeverity,
    })
    .from(notificationChannels)
    .where(and(eq(notificationChannels.orgId, e.orgId), eq(notificationChannels.enabled, true)));
  const targets = channels.filter(
    (c) => RANK[event.severity] >= RANK[c.minSeverity] && matchesPattern(event.type, c.eventTypes),
  );
  if (targets.length > 0) {
    await db
      .insert(deliveries)
      .values(targets.map((c) => ({ eventId: event.id, channelId: c.id })))
      .onConflictDoNothing();
  }
  await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({ orgId: event.orgId, id: event.id })})`);
  return event;
}

/**
 * Like recordEvent, but never throws: a notification problem must not fail
 * the run or the save that caused it. Errors are logged.
 */
export async function emitEvent(db: Db, e: NewEvent): Promise<Event | null> {
  try {
    return await recordEvent(db, e);
  } catch (err) {
    console.error("[events] could not record", e.type, (err as Error).message);
    return null;
  }
}

/** The feed, oldest first after a cursor (for polling), or newest first (for the UI). */
export async function listEvents(
  db: Db,
  actor: Actor,
  opts: { sinceId?: number; types?: string[]; limit?: number; newestFirst?: boolean } = {},
): Promise<{ events: Event[]; nextSinceId: number }> {
  assertCan(actor, "read");
  const limit = Math.min(opts.limit ?? 50, 500);
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.orgId, actor.orgId),
        opts.sinceId !== undefined ? gt(events.id, opts.sinceId) : undefined,
        opts.types?.length ? inArray(events.type, opts.types as EventType[]) : undefined,
      ),
    )
    .orderBy(opts.newestFirst ? desc(events.id) : asc(events.id))
    .limit(limit);
  const maxId = rows.reduce((m, r) => Math.max(m, r.id), opts.sinceId ?? 0);
  return { events: rows, nextSinceId: maxId };
}

export async function getEventForOrg(db: Db, orgId: string, id: number): Promise<Event | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.id, id)));
  return row ?? null;
}
