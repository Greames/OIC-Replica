import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orgs } from "./auth.js";
import { instances } from "./runtime.js";

// Batch pipelines (P4): progress per run and step, so a stopped run resumes
// after its last finished chunk, and the records that were set aside.

const count = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

export const pipelineCheckpoints = pgTable(
  "pipeline_checkpoints",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    /** The source position after the last committed chunk (adapter-defined JSON). */
    cursor: jsonb("cursor"),
    read: count("read"),
    written: count("written"),
    filtered: count("filtered"),
    rejected: count("rejected"),
    chunks: integer("chunks").notNull().default(0),
    status: text("status", { enum: ["running", "done"] })
      .notNull()
      .default("running"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.stepId] }), index().on(t.orgId)],
);

export const pipelineRejects = pgTable(
  "pipeline_rejects",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),
    chunk: integer("chunk").notNull(),
    rowIndex: integer("row_index").notNull(),
    stage: text("stage", { enum: ["transform", "write"] }).notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    /** The record, shortened when large. */
    record: jsonb("record"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.instanceId, t.stepId, t.id), index().on(t.orgId)],
);
