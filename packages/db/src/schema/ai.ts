import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orgs, users } from "./auth.js";
import { projects } from "./core.js";
import { integrations } from "./runtime.js";

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const AI_SESSION_STATUSES = ["idle", "running", "waiting", "error"] as const;

/** A question the AI asked; the loop is paused until the user answers. */
export interface PendingQuestion {
  toolUseId: string;
  question: string;
  choices: string[];
  /** Results of the other tool calls in the same assistant turn, sent together with the answer. */
  otherResults: unknown[];
}

/** S28. One conversation with the AI builder, optionally about one integration. */
export const aiSessions = pgTable(
  "ai_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: text("status", { enum: AI_SESSION_STATUSES }).notNull().default("idle"),
    pending: jsonb("pending").$type<PendingQuestion | null>(),
    lastError: text("last_error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index().on(t.orgId, t.userId, t.updatedAt), index().on(t.integrationId)],
);

/**
 * The conversation, append-only, exactly as sent to and returned by the model
 * (content blocks including tool_use, tool_result and thinking). Never edited:
 * thinking blocks stay valid only on an unchanged history.
 */
export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Copied from the parent row, so row-level security can check it directly. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => aiSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: jsonb("content").$type<unknown[]>().notNull(),
    model: text("model"),
    stopReason: text("stop_reason"),
    usage: jsonb("usage"),
    createdAt: created(),
  },
  (t) => [uniqueIndex().on(t.sessionId, t.seq)],
);

export const AI_CHANGE_STATUSES = ["proposed", "accepted", "rejected", "stale"] as const;

/** S29. A proposal from the AI. Nothing reaches an integration until a person accepts it. */
export const aiChanges = pgTable(
  "ai_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => aiSessions.id, { onDelete: "cascade" }),
    /** null: the proposal creates a new integration. */
    integrationId: uuid("integration_id").references(() => integrations.id, { onDelete: "cascade" }),
    baseHash: text("base_hash"),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    proposedDefinition: jsonb("proposed_definition").notNull(),
    schedule: jsonb("schedule").$type<{ kind: "interval" | "cron"; expression: string; timezone: string } | null>(),
    diff: jsonb("diff").notNull(),
    warnings: jsonb("warnings").$type<unknown[]>().notNull().default([]),
    status: text("status", { enum: AI_CHANGE_STATUSES }).notNull().default("proposed"),
    resultIntegrationId: uuid("result_integration_id").references(() => integrations.id, { onDelete: "set null" }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index().on(t.sessionId), index().on(t.integrationId)],
);
