import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs, users } from "./auth.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const EVENT_TYPES = [
  "integration.created",
  "integration.updated",
  "integration.activated",
  "integration.deactivated",
  "instance.succeeded",
  "instance.failed",
  "schedule.skipped",
  "connection.test_passed",
  "connection.test_failed",
  "ai.question",
  "ai.change.proposed",
  "ai.change.accepted",
  "ai.change.rejected",
  "channel.test",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const SEVERITIES = ["info", "warning", "error"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * The event outbox. Every state change writes one row (in the same
 * transaction where it matters); the app's live view, notification channels,
 * the API and the MCP server all read from here. The id is a monotonic
 * cursor: "give me everything after 1042".
 */
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    type: text("type").$type<EventType>().notNull(),
    severity: text("severity", { enum: SEVERITIES }).notNull().default("info"),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** One human line, ready for Slack or Telegram. */
    summary: text("summary").notNull(),
    /** Link path inside the app, e.g. /observability/runs/<id>. */
    path: text("path"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [index().on(t.orgId, t.id), index().on(t.orgId, t.type, t.id)],
);

export const CHANNEL_KINDS = ["slack", "telegram", "email", "webhook"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** Where updates go: Slack, Telegram, email, or a signed webhook (e.g. Hermes Agent). */
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: CHANNEL_KINDS }).notNull(),
    name: text("name").notNull(),
    /** URL / bot token / chat id / addresses / signing secret, encrypted. */
    configCiphertext: bytea("config_ciphertext").notNull(),
    /** Patterns like "*", "instance.*", "instance.failed". */
    eventTypes: text("event_types").array().notNull().default(["*"]),
    minSeverity: text("min_severity", { enum: SEVERITIES }).notNull().default("info"),
    enabled: boolean("enabled").notNull().default(true),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index().on(t.orgId)],
);

export const DELIVERY_STATUSES = ["pending", "sent", "failed"] as const;

/** One event to one channel, retried with backoff. Unique per pair, so fan-out is idempotent. */
export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.eventId, t.channelId), index().on(t.status, t.nextAttemptAt)],
);

export const API_SCOPES = ["read", "build", "operate"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Keys for the public API and the MCP server (Hermes Agent, scripts). Only a hash is stored. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** First characters, shown in the UI to tell keys apart. */
    prefix: text("prefix").notNull().unique(),
    hash: text("hash").notNull(),
    scopes: text("scopes").array().$type<ApiScope[]>().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [index().on(t.orgId)],
);
