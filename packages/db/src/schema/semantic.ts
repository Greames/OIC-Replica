import type { Attribute } from "@oicr/semantic";
import { boolean, index, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orgs, users } from "./auth.js";

// The workspace's layer of the semantic graph (P3). The platform catalog and
// its bindings ship in @oicr/semantic; these tables hold only what a
// workspace adds or changes, and AI binding proposals waiting for review.

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const org = () =>
  uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" });

/** A workspace entity, or attributes added to a platform entity of the same name. */
export const semanticEntities = pgTable(
  "semantic_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: org(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    attributes: jsonb("attributes").$type<Attribute[]>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex().on(t.orgId, t.name)],
);

/** A system object (table, resource, record type) and the entity it holds. */
export const semanticObjects = pgTable(
  "semantic_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: org(),
    system: text("system").notNull(),
    object: text("object").notNull(),
    entity: text("entity").notNull(),
    label: text("label"),
    description: text("description"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex().on(t.orgId, t.system, t.object)],
);

export const BINDING_ORIGINS = ["manual", "ai"] as const;

/** One technical field → attribute; attribute null switches a platform binding off. */
export const semanticBindings = pgTable(
  "semantic_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: org(),
    system: text("system").notNull(),
    object: text("object").notNull(),
    field: text("field").notNull(),
    attribute: text("attribute"),
    readTransform: text("read_transform"),
    writeTransform: text("write_transform"),
    readOnly: boolean("read_only").notNull().default(false),
    origin: text("origin", { enum: BINDING_ORIGINS }).notNull(),
    confidence: real("confidence"),
    evidence: text("evidence"),
    proposalId: uuid("proposal_id"),
    /** Who approved it: a person, or null when the auto-approval policy did. */
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex().on(t.orgId, t.system, t.object, t.field), index().on(t.orgId, t.system)],
);

export const PROPOSAL_DECISIONS = ["pending", "approved", "auto_approved", "rejected"] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];

export interface ProposalItem {
  field: string;
  attribute: string;
  confidence: number;
  evidence: string;
  read?: string;
  write?: string;
  /** Why it needs a person: it disagrees with what is bound now. */
  conflict?: string;
  decision: ProposalDecision;
  decidedBy?: string | null;
  decidedAt?: string;
}

/** An AI binding proposal for one object, reviewed item by item. */
export const semanticProposals = pgTable(
  "semantic_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: org(),
    system: text("system").notNull(),
    object: text("object").notNull(),
    entity: text("entity").notNull(),
    entityConfidence: real("entity_confidence").notNull(),
    reasoning: text("reasoning").notNull().default(""),
    /** "Gemini · gemini-4-argon": which model proposed it. */
    model: text("model").notNull(),
    items: jsonb("items").$type<ProposalItem[]>().notNull(),
    unmapped: jsonb("unmapped").$type<{ field: string; reason: string }[]>().notNull().default([]),
    dropped: jsonb("dropped").$type<{ field: string; attribute: string; reason: string }[]>().notNull().default([]),
    /** Field names and types only; sample values are never stored. */
    fields: jsonb("fields").$type<{ field: string; type: string }[]>().notNull().default([]),
    autoApproveAt: real("auto_approve_at"),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: created(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.status), index().on(t.orgId, t.system, t.object)],
);
