import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.js";
import { deliveries, events, notificationChannels, SEVERITIES } from "../schema/events.js";
import { secretStore } from "../secret-store.js";
import { type Actor, assertCan, NotFoundError } from "./access.js";

// Notification channels. Config (webhook URLs, bot tokens, signing secrets)
// is encrypted; the UI only ever sees a masked summary.

const SlackConfig = z.object({
  webhookUrl: z
    .string()
    .url("Paste the full webhook URL from Slack.")
    .refine((u) => u.startsWith("https://hooks.slack.com/"), "Slack webhook URLs start with https://hooks.slack.com/"),
});
const TelegramConfig = z.object({
  botToken: z.string().regex(/^\d+:[\w-]{20,}$/, "That does not look like a bot token from @BotFather (123456:ABC…)."),
  chatId: z.string().regex(/^-?\d+$|^@\w{4,}$/, "Use the numeric chat id (e.g. 123456789 or -100…) or @channelname."),
});
const EmailConfig = z.object({
  to: z.array(z.string().email("Enter valid email addresses.")).min(1, "Add at least one address."),
});
const WebhookConfig = z.object({
  url: z
    .string()
    .url("Enter the full URL.")
    .refine((u) => /^https?:\/\//.test(u), "Use http:// or https://"),
  secret: z.string().min(16, "Use a signing secret of at least 16 characters."),
});

export const ChannelConfig = {
  slack: SlackConfig,
  telegram: TelegramConfig,
  email: EmailConfig,
  webhook: WebhookConfig,
} as const;
export type ChannelConfigFor<K extends keyof typeof ChannelConfig> = z.infer<(typeof ChannelConfig)[K]>;

export const ChannelInput = z.object({
  kind: z.enum(["slack", "telegram", "email", "webhook"]),
  name: z.string().trim().min(1, "Give the channel a name.").max(80),
  eventTypes: z
    .array(z.string().regex(/^(\*|[a-z_]+\.\*|[a-z_]+\.[a-z_.]+)$/))
    .min(1)
    .default(["*"]),
  minSeverity: z.enum(SEVERITIES).default("info"),
  config: z.record(z.string(), z.unknown()),
});
export type ChannelInput = z.input<typeof ChannelInput>;

type Row = typeof notificationChannels.$inferSelect;
export type ChannelView = Omit<Row, "configCiphertext">;

const configRef = (orgId: string, id: string) => ({ tenant: orgId, kind: "channel" as const, id });

function mask(kind: Row["kind"], config: Record<string, unknown>): string {
  switch (kind) {
    case "slack":
      return `Slack webhook …${String(config.webhookUrl).slice(-6)}`;
    case "telegram":
      return `Telegram chat ${config.chatId}`;
    case "email":
      return (config.to as string[]).join(", ");
    case "webhook": {
      const u = new URL(String(config.url));
      return `${u.protocol}//${u.host}${u.pathname}`;
    }
  }
}

function view(row: Row): ChannelView {
  const { configCiphertext: _legacy, ...rest } = row;
  return rest;
}

export const maskChannelTarget = mask;

export async function listChannels(db: Db, actor: Actor): Promise<ChannelView[]> {
  assertCan(actor, "read");
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.orgId, actor.orgId))
    .orderBy(asc(notificationChannels.createdAt));
  return rows.map(view);
}

export async function createChannel(db: Db, actor: Actor, input: ChannelInput): Promise<ChannelView> {
  assertCan(actor, "admin");
  const data = ChannelInput.parse(input);
  const config = ChannelConfig[data.kind].parse(data.config);
  const [row] = await db
    .insert(notificationChannels)
    .values({
      orgId: actor.orgId,
      kind: data.kind,
      name: data.name,
      target: mask(data.kind, config),
      eventTypes: data.eventTypes,
      minSeverity: data.minSeverity,
      // Paused until its settings are stored, so no delivery can see it half-made.
      enabled: false,
      createdBy: actor.userId,
    })
    .returning();
  try {
    await secretStore(db).put(configRef(actor.orgId, row!.id), config);
  } catch (e) {
    await db.delete(notificationChannels).where(eq(notificationChannels.id, row!.id));
    throw e;
  }
  const [ready] = await db
    .update(notificationChannels)
    .set({ enabled: true })
    .where(eq(notificationChannels.id, row!.id))
    .returning();
  return view(ready!);
}

export async function setChannelEnabled(db: Db, actor: Actor, id: string, enabled: boolean): Promise<void> {
  assertCan(actor, "admin");
  const r = await db
    .update(notificationChannels)
    .set({ enabled })
    .where(and(eq(notificationChannels.orgId, actor.orgId), eq(notificationChannels.id, id)))
    .returning({ id: notificationChannels.id });
  if (r.length === 0) throw new NotFoundError("Channel");
}

export async function deleteChannel(db: Db, actor: Actor, id: string): Promise<void> {
  assertCan(actor, "admin");
  const [row] = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(and(eq(notificationChannels.orgId, actor.orgId), eq(notificationChannels.id, id)));
  if (!row) return;
  await secretStore(db).delete(configRef(actor.orgId, id));
  await db
    .delete(notificationChannels)
    .where(and(eq(notificationChannels.orgId, actor.orgId), eq(notificationChannels.id, id)));
}

export async function recentDeliveries(db: Db, actor: Actor, channelId: string, limit = 10) {
  assertCan(actor, "read");
  return db
    .select({
      id: deliveries.id,
      status: deliveries.status,
      attempts: deliveries.attempts,
      lastError: deliveries.lastError,
      sentAt: deliveries.sentAt,
      createdAt: deliveries.createdAt,
      summary: events.summary,
      type: events.type,
    })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .innerJoin(notificationChannels, eq(notificationChannels.id, deliveries.channelId))
    .where(and(eq(deliveries.channelId, channelId), eq(notificationChannels.orgId, actor.orgId)))
    .orderBy(desc(deliveries.createdAt))
    .limit(limit);
}

// ── delivery worker side (no actor: runs as the system) ─────────────────────

export const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [60, 300, 1800, 7200];

export interface DueDelivery {
  id: string;
  attempts: number;
  channel: { id: string; kind: Row["kind"]; name: string; config: Record<string, unknown> };
  event: typeof events.$inferSelect;
}

/**
 * Claims due deliveries (SKIP LOCKED) and pushes their next attempt out, so a
 * crash cannot double-send quickly. Channel settings are read from the secret
 * store after the claim commits, so no row lock waits on Vault. A delivery
 * whose settings cannot be read now is rescheduled (store unavailable) or
 * failed (settings missing); it never blocks the others.
 */
export async function claimDueDeliveries(db: Db, limit = 20, now = new Date()): Promise<DueDelivery[]> {
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ delivery: deliveries, channel: notificationChannels, event: events })
      .from(deliveries)
      .innerJoin(notificationChannels, eq(notificationChannels.id, deliveries.channelId))
      .innerJoin(events, eq(events.id, deliveries.eventId))
      .where(and(eq(deliveries.status, "pending"), lte(deliveries.nextAttemptAt, now)))
      .orderBy(asc(deliveries.nextAttemptAt))
      .limit(limit)
      .for("update", { of: deliveries, skipLocked: true });
    for (const r of rows) {
      await tx
        .update(deliveries)
        .set({ attempts: sql`${deliveries.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 60_000) })
        .where(eq(deliveries.id, r.delivery.id));
    }
    return rows;
  });
  const due: DueDelivery[] = [];
  for (const r of claimed) {
    const d: DueDelivery = {
      id: r.delivery.id,
      attempts: r.delivery.attempts + 1,
      channel: { id: r.channel.id, kind: r.channel.kind, name: r.channel.name, config: {} },
      event: r.event,
    };
    let config: Record<string, unknown> | null;
    try {
      config = await secretStore(db).get(configRef(r.channel.orgId, r.channel.id));
    } catch (e) {
      await markDeliveryFailed(db, d, `The channel's settings could not be read: ${(e as Error).message}`, true, now);
      continue;
    }
    if (!config) {
      await markDeliveryFailed(
        db,
        d,
        "The channel's settings are missing. Delete and re-create the channel.",
        false,
        now,
      );
      continue;
    }
    due.push({ ...d, channel: { ...d.channel, config } });
  }
  return due;
}

export async function markDelivered(db: Db, d: DueDelivery): Promise<void> {
  await db
    .update(deliveries)
    .set({ status: "sent", sentAt: new Date(), lastError: null })
    .where(eq(deliveries.id, d.id));
  await db
    .update(notificationChannels)
    .set({ lastDeliveredAt: new Date(), lastError: null })
    .where(eq(notificationChannels.id, d.channel.id));
}

/** Schedules a retry (1m, 5m, 30m, 2h) or gives up after MAX_ATTEMPTS. */
export async function markDeliveryFailed(
  db: Db,
  d: DueDelivery,
  error: string,
  retryable: boolean,
  now = new Date(),
): Promise<"retry" | "failed"> {
  const giveUp = !retryable || d.attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_SECONDS[Math.min(d.attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 7200;
  await db
    .update(deliveries)
    .set({
      status: giveUp ? "failed" : "pending",
      lastError: error.slice(0, 500),
      nextAttemptAt: new Date(now.getTime() + wait * 1000),
    })
    .where(eq(deliveries.id, d.id));
  await db
    .update(notificationChannels)
    .set({ lastError: error.slice(0, 500) })
    .where(eq(notificationChannels.id, d.channel.id));
  return giveUp ? "failed" : "retry";
}

/** For "Send test": loads one channel's decrypted config. */
export async function loadChannelForSend(db: Db, actor: Actor, id: string) {
  assertCan(actor, "admin");
  const [row] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.orgId, actor.orgId), eq(notificationChannels.id, id)));
  if (!row) throw new NotFoundError("Channel");
  const config = await secretStore(db).get(configRef(row.orgId, row.id));
  if (!config) throw new NotFoundError("Channel settings");
  return { id: row.id, kind: row.kind, name: row.name, config };
}
