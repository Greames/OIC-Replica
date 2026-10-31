import type { SemanticPlan } from "@oicr/semantic";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
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
import { projects } from "./core.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const RUN_LANES = ["standard", "batch"] as const;
export const CONNECTION_ROLES = ["trigger", "invoke", "trigger_invoke"] as const;
export const AUTH_TYPES = ["none", "basic", "api_key", "bearer"] as const;
export const CONNECTION_STATUSES = ["draft", "configured", "failed"] as const;

/**
 * S14/S16. Non-secret settings in `properties`. Credentials live in the secret
 * store (Vault) under tenants/{org}/connection/{id}; `hasSecret` says whether
 * one is stored. `secretCiphertext` only holds pre-v2 data until it is migrated.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    identifier: text("identifier").notNull(),
    adapter: text("adapter").notNull(),
    role: text("role", { enum: CONNECTION_ROLES }).notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    authType: text("auth_type", { enum: AUTH_TYPES }).notNull().default("none"),
    hasSecret: boolean("has_secret").notNull().default(false),
    /** Legacy (pre-v2): moved to the secret store by `migrate`, then emptied. */
    secretCiphertext: bytea("secret_ciphertext"),
    status: text("status", { enum: CONNECTION_STATUSES }).notNull().default("draft"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestError: text("last_test_error"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex().on(t.orgId, t.identifier),
    index().on(t.projectId),
    check("connections_identifier_format", sql`${t.identifier} ~ '^[a-z][a-z0-9_]{0,49}$'`),
  ],
);

export const INTEGRATION_STATUSES = ["draft", "configured", "active", "failed", "inactive"] as const;
export const TRACING_LEVELS = ["production", "audit", "debug"] as const;

/** S04/S06. `definition` is a FlowDoc, validated by @oicr/flow-schema on every save. */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    identifier: text("identifier").notNull(),
    version: text("version").notNull().default("01.00.0000"),
    style: text("style", { enum: ["application", "scheduled"] }).notNull(),
    status: text("status", { enum: INTEGRATION_STATUSES }).notNull().default("draft"),
    definition: jsonb("definition").notNull(),
    definitionHash: text("definition_hash").notNull(),
    validationErrors: jsonb("validation_errors").$type<unknown[]>().notNull().default([]),
    tracingLevel: text("tracing_level", { enum: TRACING_LEVELS }).notNull().default("audit"),
    /** Sample payloads pasted in the mapper, by source ("trigger", a step id). Not part of the definition. */
    samples: jsonb("samples").$type<Record<string, unknown>>().notNull().default({}),
    /** sha256 of the trigger token; the token itself is shown once and never stored. */
    triggerTokenHash: text("trigger_token_hash"),
    /** Last characters of the token, to tell tokens apart in the UI. */
    triggerTokenHint: text("trigger_token_hint"),
    /** Legacy (pre-v2): hashed by `migrate`, then emptied. */
    triggerTokenCiphertext: bytea("trigger_token_ciphertext"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedBy: uuid("activated_by").references(() => users.id, { onDelete: "set null" }),
    /** The immutable plan the data plane runs while the integration is active. */
    activePlanId: uuid("active_plan_id").references((): AnyPgColumn => integrationPlans.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex().on(t.orgId, t.identifier, t.version),
    index().on(t.projectId),
    index().on(t.orgId, t.status),
    check("integrations_identifier_format", sql`${t.identifier} ~ '^[A-Z][A-Z0-9_]{0,49}$'`),
  ],
);

/** S10. One per scheduled integration. `nextRunAt` is computed in `timezone`. */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .unique()
      .references(() => integrations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["interval", "cron"] }).notNull(),
    expression: text("expression").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status", { enum: ["active", "paused"] })
      .notNull()
      .default("active"),
    allowOverlap: boolean("allow_overlap").notNull().default(false),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index().on(t.status, t.nextRunAt)],
);

export const INSTANCE_STATUSES = ["queued", "running", "succeeded", "failed", "aborted"] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];
export const TRIGGER_KINDS = ["request", "schedule", "manual", "resubmit"] as const;

/** S21/S22. One run of one integration version. */
export const instances = pgTable(
  "instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    integrationVersion: text("integration_version").notNull(),
    definitionHash: text("definition_hash").notNull(),
    /** What runs: the plan that was active when the run was created. */
    planId: uuid("plan_id").references(() => integrationPlans.id, { onDelete: "set null" }),
    status: text("status", { enum: INSTANCE_STATUSES }).notNull().default("queued"),
    triggerKind: text("trigger_kind", { enum: TRIGGER_KINDS }).notNull(),
    parentInstanceId: uuid("parent_instance_id"),
    idempotencyKey: text("idempotency_key"),
    primaryBusinessId: text("primary_business_id"),
    businessIds: jsonb("business_ids").$type<Record<string, string>>().notNull().default({}),
    // Payloads live in Postgres (capped) until object storage arrives.
    input: jsonb("input"),
    output: jsonb("output"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    /** "batch": the flow has a pipeline, so the batch engine runs it (and resumes it after a crash). */
    lane: text("lane", { enum: RUN_LANES }).notNull().default("standard"),
    /** Batch runs: last sign of life from the engine running it. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** How many times a batch run was started (a resumed run counts again). */
    attempts: integer("attempts").notNull().default(1),
    createdAt: created(),
  },
  (t) => [
    index().on(t.orgId, t.createdAt),
    index().on(t.lane, t.status),
    index().on(t.integrationId, t.createdAt),
    index().on(t.orgId, t.status, t.createdAt),
    index().on(t.orgId, t.primaryBusinessId),
    uniqueIndex().on(t.integrationId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  ],
);

export type RunLane = (typeof RUN_LANES)[number];

/** S22 activity stream. One row per executed step (per loop iteration). */
export const instanceSteps = pgTable(
  "instance_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Copied from the parent row, so row-level security can check it directly. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stepId: text("step_id").notNull(),
    stepType: text("step_type").notNull(),
    iteration: integer("iteration"),
    status: text("status", { enum: ["succeeded", "failed", "skipped"] }).notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    message: text("message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex().on(t.instanceId, t.seq)],
);

/**
 * An execution plan: the definition as it was activated, immutable. Runs
 * reference the plan they were created with, so editing or re-activating an
 * integration never changes what an already-queued run executes, and the data
 * plane needs nothing but plans.
 */
export const integrationPlans = pgTable(
  "integration_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references((): AnyPgColumn => integrations.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    definitionHash: text("definition_hash").notNull(),
    definition: jsonb("definition").notNull(),
    tracingLevel: text("tracing_level", { enum: TRACING_LEVELS }).notNull(),
    /** The compiled semantic bindings the definition uses (null: it uses none). */
    semantics: jsonb("semantics").$type<SemanticPlan>(),
    /** SemanticPlan.hash, or "" without semantics; part of what makes a plan reusable. */
    semanticHash: text("semantic_hash").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("integration_plans_reuse_index").on(t.integrationId, t.definitionHash, t.tracingLevel, t.semanticHash),
    index().on(t.orgId),
  ],
);

export const TENANT_TIERS = ["standard", "business", "dedicated"] as const;

/** Per-tenant execution limits. No row means the platform defaults for "standard". */
export const tenantLimits = pgTable("tenant_limits", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  tier: text("tier", { enum: TENANT_TIERS }).notNull().default("standard"),
  /** Concurrent synchronous calls per stream engine instance. */
  syncConcurrency: integer("sync_concurrency"),
  /** Trigger requests per second per stream engine instance (bursts up to 2x). */
  requestsPerSecond: integer("requests_per_second"),
  updatedAt: updated(),
});
