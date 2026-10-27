import { parseExpression } from "@oicr/flow-schema";
import {
  Attribute,
  AttributeName,
  type CheckedProposal,
  EntityName,
  FieldPath,
  ObjectName,
  type SemanticGraph,
  SemanticGraph as SemanticGraphClass,
  type SemanticPlan,
  SystemId,
  staleObjects,
} from "@oicr/semantic";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.js";
import { integrationPlans } from "../schema/runtime.js";
import {
  type ProposalItem,
  semanticBindings,
  semanticEntities,
  semanticObjects,
  semanticProposals,
} from "../schema/semantic.js";
import { asTenant } from "../tenancy.js";
import { type Actor, assertCan, ConflictError, NotFoundError } from "./access.js";
import { emitEvent } from "./events.js";
import { InvalidStateError } from "./integrations.js";

export type SemanticProposal = typeof semanticProposals.$inferSelect;
export type { ProposalItem };

/** The workspace's semantic graph: the platform catalog with the workspace's layer applied. */
export async function loadSemanticGraph(db: Db, orgId: string): Promise<SemanticGraph> {
  return asTenant(db, orgId, async (db) => {
    const [entities, objects, bindings] = await Promise.all([
      db.select().from(semanticEntities).where(eq(semanticEntities.orgId, orgId)),
      db.select().from(semanticObjects).where(eq(semanticObjects.orgId, orgId)),
      db.select().from(semanticBindings).where(eq(semanticBindings.orgId, orgId)),
    ]);
    return new SemanticGraphClass({
      entities: entities.map((e) => ({
        name: e.name,
        label: e.label,
        description: e.description,
        attributes: e.attributes,
      })),
      objects,
      bindings: bindings.map((b) => ({
        system: b.system,
        object: b.object,
        field: b.field,
        attribute: b.attribute,
        read: b.readTransform,
        write: b.writeTransform,
        readOnly: b.readOnly,
        confidence: b.confidence,
        evidence: b.evidence,
      })),
    });
  });
}

export async function getSemanticGraph(db: Db, actor: Actor): Promise<SemanticGraph> {
  assertCan(actor, "read");
  return loadSemanticGraph(db, actor.orgId);
}

const transform = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((v) => v || null)
  .refine((v) => v === null || parseExpression(v).ok, "Not a valid JSONata expression.");

// ── entities ──────────────────────────────────────────────────────────────

export const EntityInput = z.object({
  name: EntityName,
  label: z.string().trim().min(1, "Give it a label.").max(80),
  description: z.string().trim().max(500).default(""),
  attributes: z.array(Attribute).max(200),
});
export type EntityInput = z.input<typeof EntityInput>;

/**
 * Saves a workspace entity, or the attributes a workspace adds to a platform
 * entity of the same name. Attributes that bindings use cannot be removed.
 */
export async function saveEntity(db: Db, actor: Actor, input: EntityInput) {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "build");
    const data = EntityInput.parse(input);
    const graph = await loadSemanticGraph(db, actor.orgId);
    const current = graph.entity(data.name);
    const names = new Set<string>();
    for (const a of data.attributes) {
      if (names.has(a.name)) throw new InvalidStateError(`Attribute "${a.name}" is there twice.`);
      names.add(a.name);
      if (current?.origin === "platform" && !current.extended?.includes(a.name) && graph.attribute(data.name, a.name))
        throw new InvalidStateError(`${data.name} already has "${a.name}" in the platform catalog.`);
      if (a.references && !graph.entity(a.references))
        throw new InvalidStateError(`"${a.name}" references ${a.references}, which does not exist.`);
    }
    const ownedBefore =
      current?.origin === "platform" ? (current.extended ?? []) : (current?.attributes.map((a) => a.name) ?? []);
    for (const removed of ownedBefore.filter((n) => !names.has(n))) {
      const user = graph.objects({ entity: data.name }).find((o) => o.fields.some((f) => f.attribute === removed));
      if (user)
        throw new InvalidStateError(
          `${data.name}.${removed} is bound by ${user.object} (${user.system}); unbind it there first.`,
        );
    }
    const [row] = await db
      .insert(semanticEntities)
      .values({ orgId: actor.orgId, ...data, createdBy: actor.userId })
      .onConflictDoUpdate({
        target: [semanticEntities.orgId, semanticEntities.name],
        set: { label: data.label, description: data.description, attributes: data.attributes },
      })
      .returning();
    return row!;
  });
}

/** Adds one attribute to an entity (platform or workspace). */
export async function addAttribute(db: Db, actor: Actor, entity: string, attribute: z.input<typeof Attribute>) {
  return asTenant(db, actor.orgId, async (db) => {
    const [row] = await db
      .select()
      .from(semanticEntities)
      .where(and(eq(semanticEntities.orgId, actor.orgId), eq(semanticEntities.name, entity)));
    const graph = await loadSemanticGraph(db, actor.orgId);
    const e = graph.entity(entity);
    if (!e) throw new NotFoundError("Entity");
    return saveEntity(db, actor, {
      name: entity,
      label: row?.label ?? e.label,
      description: row?.description ?? "",
      attributes: [...(row?.attributes ?? []), attribute],
    });
  });
}

export async function deleteEntity(db: Db, actor: Actor, name: string): Promise<void> {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "build");
    const graph = await loadSemanticGraph(db, actor.orgId);
    const e = graph.entity(name);
    if (!e || (e.origin === "platform" && !e.extended)) throw new NotFoundError("Entity");
    if (e.origin === "tenant") {
      const bound = graph.objects({ entity: name });
      if (bound.length > 0)
        throw new InvalidStateError(
          `${name} is bound by ${bound.map((o) => o.object).join(", ")}; unbind those first.`,
        );
    } else {
      const user = graph.objects({ entity: name }).find((o) => o.fields.some((f) => e.extended?.includes(f.attribute)));
      if (user) throw new InvalidStateError(`${user.object} binds attributes you added to ${name}; unbind them first.`);
    }
    await db
      .delete(semanticEntities)
      .where(and(eq(semanticEntities.orgId, actor.orgId), eq(semanticEntities.name, name)));
  });
}

// ── objects ───────────────────────────────────────────────────────────────

export const ObjectInput = z.object({
  system: SystemId,
  object: ObjectName,
  entity: EntityName,
  label: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(500).nullish(),
});
export type ObjectInput = z.input<typeof ObjectInput>;

/** Binds a system object to an entity (new, or overriding the platform's choice). */
export async function saveObject(db: Db, actor: Actor, input: ObjectInput) {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "build");
    const data = ObjectInput.parse(input);
    const graph = await loadSemanticGraph(db, actor.orgId);
    if (!graph.entity(data.entity)) throw new InvalidStateError(`Entity ${data.entity} does not exist.`);
    const before = graph.object(data.system, data.object);
    const [row] = await db
      .insert(semanticObjects)
      .values({ orgId: actor.orgId, ...data, createdBy: actor.userId })
      .onConflictDoUpdate({
        target: [semanticObjects.orgId, semanticObjects.system, semanticObjects.object],
        set: { entity: data.entity, label: data.label ?? null, description: data.description ?? null },
      })
      .returning();
    // Field bindings belong to the entity; a different entity starts over.
    if (before && before.entity !== data.entity)
      await db
        .delete(semanticBindings)
        .where(
          and(
            eq(semanticBindings.orgId, actor.orgId),
            eq(semanticBindings.system, data.system),
            eq(semanticBindings.object, data.object),
          ),
        );
    await changed(db, actor, data.system, data.object, `${data.object} (${data.system}) is bound to ${data.entity}.`);
    return row!;
  });
}

/** Removes the workspace's object and its bindings; a platform object returns to its platform bindings. */
export async function resetObject(db: Db, actor: Actor, system: string, object: string): Promise<void> {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "build");
    const where = (t: typeof semanticObjects | typeof semanticBindings) =>
      and(eq(t.orgId, actor.orgId), eq(t.system, system), eq(t.object, object));
    await db.delete(semanticBindings).where(where(semanticBindings));
    await db.delete(semanticObjects).where(where(semanticObjects));
    await changed(db, actor, system, object, `The workspace's bindings of ${object} (${system}) were removed.`);
  });
}

// ── field bindings ────────────────────────────────────────────────────────

export const BindingInput = z.object({
  system: SystemId,
  object: ObjectName,
  field: FieldPath,
  /** null switches off the platform binding of this field. */
  attribute: AttributeName.nullable(),
  read: transform,
  write: transform,
  readOnly: z.boolean().default(false),
});
export type BindingInput = z.input<typeof BindingInput>;

export interface BindingSource {
  origin?: "manual" | "ai";
  confidence?: number | null;
  evidence?: string | null;
  proposalId?: string | null;
  /** Who approved; null when the auto-approval policy did. Defaults to the actor. */
  approvedBy?: string | null;
  /** Move the attribute here when another workspace field holds it (an explicit approval). */
  replace?: boolean;
  /** No event (bulk changes emit their own). */
  quiet?: boolean;
}

export async function setBinding(db: Db, actor: Actor, input: BindingInput, source: BindingSource = {}) {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "build");
    const data = BindingInput.parse(input);
    const graph = await loadSemanticGraph(db, actor.orgId);
    const o = graph.object(data.system, data.object);
    if (!o) throw new InvalidStateError(`Bind ${data.object} (${data.system}) to an entity first.`);
    if (data.attribute !== null) {
      if (!graph.attribute(o.entity, data.attribute))
        throw new InvalidStateError(`${o.entity} has no attribute "${data.attribute}".`);
      const holder = o.fields.find((f) => f.attribute === data.attribute && f.field !== data.field);
      if (holder?.origin === "tenant") {
        if (!source.replace)
          throw new ConflictError(
            `${o.entity}.${data.attribute} is already bound to ${holder.field}. Unbind that field first.`,
          );
        await db
          .delete(semanticBindings)
          .where(
            and(
              eq(semanticBindings.orgId, actor.orgId),
              eq(semanticBindings.system, data.system),
              eq(semanticBindings.object, data.object),
              eq(semanticBindings.field, holder.field),
            ),
          );
      }
    }
    const values = {
      attribute: data.attribute,
      readTransform: data.read,
      writeTransform: data.write,
      readOnly: data.readOnly,
      origin: source.origin ?? "manual",
      confidence: source.confidence ?? null,
      evidence: source.evidence ?? null,
      proposalId: source.proposalId ?? null,
      approvedBy: source.approvedBy === undefined ? actor.userId : source.approvedBy,
    };
    const [row] = await db
      .insert(semanticBindings)
      .values({ orgId: actor.orgId, system: data.system, object: data.object, field: data.field, ...values })
      .onConflictDoUpdate({
        target: [semanticBindings.orgId, semanticBindings.system, semanticBindings.object, semanticBindings.field],
        set: values,
      })
      .returning();
    if (!source.quiet)
      await changed(
        db,
        actor,
        data.system,
        data.object,
        data.attribute === null
          ? `${data.object}.${data.field} (${data.system}) is no longer bound.`
          : `${data.object}.${data.field} (${data.system}) is bound to ${o.entity}.${data.attribute}.`,
      );
    return row!;
  });
}

/** The workspace's own binding rows for an object (including switched-off platform fields). */
export async function listObjectBindings(db: Db, actor: Actor, system: string, object: string) {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "read");
    return db
      .select()
      .from(semanticBindings)
      .where(
        and(
          eq(semanticBindings.orgId, actor.orgId),
          eq(semanticBindings.system, system),
          eq(semanticBindings.object, object),
        ),
      );
  });
}

/** Removes the workspace's binding of a field (the platform binding, if any, applies again). */
export async function resetBinding(db: Db, actor: Actor, system: string, object: string, field: string) {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "build");
    await db
      .delete(semanticBindings)
      .where(
        and(
          eq(semanticBindings.orgId, actor.orgId),
          eq(semanticBindings.system, system),
          eq(semanticBindings.object, object),
          eq(semanticBindings.field, field),
        ),
      );
    await changed(db, actor, system, object, `${object}.${field} (${system}) is back to its platform binding.`);
  });
}

async function changed(db: Db, actor: Actor, system: string, object: string, summary: string) {
  await emitEvent(db, {
    orgId: actor.orgId,
    type: "semantic.bindings_changed",
    subjectType: "semantic_object",
    subjectId: actor.orgId,
    summary,
    path: catalogPath(system, object),
    data: { system, object, by: actor.userId },
  });
}

export const catalogPath = (system: string, object: string) =>
  `/catalog/systems/${encodeURIComponent(system)}/${encodeURIComponent(object)}`;

// ── AI proposals ──────────────────────────────────────────────────────────

/** Default confidence at or above which non-conflicting AI bindings apply without review. */
export const AUTO_APPROVE_AT = 0.9;

export interface RecordProposalInput {
  system: string;
  object: string;
  proposal: CheckedProposal;
  fields: { field: string; type: string }[];
  model: string;
  /** null: every binding waits for a person. */
  autoApproveAt: number | null;
  label?: string | null;
}

/**
 * Stores a checked AI proposal. Bindings at or above the threshold that do
 * not disagree with what is bound now apply at once; the rest wait for review.
 */
export async function recordProposal(db: Db, actor: Actor, input: RecordProposalInput): Promise<SemanticProposal> {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "build");
    const { system, object, proposal } = input;
    SystemId.parse(system);
    ObjectName.parse(object);
    let graph = await loadSemanticGraph(db, actor.orgId);
    let o = graph.object(system, object);
    if (!o) {
      await saveObject(db, actor, { system, object, entity: proposal.entity, label: input.label });
      graph = await loadSemanticGraph(db, actor.orgId);
      o = graph.object(system, object)!;
    }
    const threshold = input.autoApproveAt;
    const entityAgrees = o.entity === proposal.entity;
    const items: ProposalItem[] = proposal.bindings.map((b) => {
      const current = o.fields.find((f) => f.field === b.field);
      const holder = o.fields.find((f) => f.attribute === b.attribute && f.field !== b.field);
      const conflict = !entityAgrees
        ? `${object} is bound to ${o.entity}, not ${proposal.entity}.`
        : current && current.attribute !== b.attribute
          ? `${b.field} is bound to ${current.attribute} now.`
          : holder
            ? `${b.attribute} is bound to ${holder.field} now.`
            : undefined;
      const same = !conflict && current?.attribute === b.attribute;
      const auto =
        !conflict && threshold !== null && b.confidence >= threshold && proposal.entityConfidence >= threshold;
      return {
        field: b.field,
        attribute: b.attribute,
        confidence: b.confidence,
        evidence: b.evidence,
        ...(b.read ? { read: b.read } : {}),
        ...(b.write ? { write: b.write } : {}),
        ...(conflict ? { conflict } : {}),
        decision: same || auto ? "auto_approved" : "pending",
        ...(same || auto ? { decidedBy: null, decidedAt: new Date().toISOString() } : {}),
      };
    });
    const [row] = await db
      .insert(semanticProposals)
      .values({
        orgId: actor.orgId,
        system,
        object,
        entity: proposal.entity,
        entityConfidence: proposal.entityConfidence,
        reasoning: proposal.reasoning,
        model: input.model,
        items,
        unmapped: proposal.unmapped,
        dropped: proposal.dropped,
        fields: input.fields,
        autoApproveAt: threshold,
        status: items.some((i) => i.decision === "pending") ? "open" : "closed",
        closedAt: items.some((i) => i.decision === "pending") ? null : new Date(),
        createdBy: actor.userId,
      })
      .returning();
    for (const i of items) {
      const current = o.fields.find((f) => f.field === i.field);
      if (i.decision !== "auto_approved" || current?.attribute === i.attribute) continue;
      await setBinding(
        db,
        actor,
        { system, object, field: i.field, attribute: i.attribute, read: i.read, write: i.write },
        {
          origin: "ai",
          confidence: i.confidence,
          evidence: i.evidence,
          proposalId: row!.id,
          approvedBy: null,
          quiet: true,
        },
      );
    }
    const pending = items.filter((i) => i.decision === "pending").length;
    await emitEvent(db, {
      orgId: actor.orgId,
      type: "semantic.proposal_ready",
      severity: pending > 0 ? "warning" : "info",
      subjectType: "semantic_proposal",
      subjectId: row!.id,
      summary: `AI proposed ${items.length} binding(s) for ${object} (${system}) as ${proposal.entity}: ${items.length - pending} applied, ${pending} to review.`,
      path: catalogPath(system, object),
      data: { system, object, entity: proposal.entity, pending, by: actor.userId },
    });
    return row!;
  });
}

export const ProposalDecisionInput = z.object({
  field: z.string(),
  decision: z.enum(["approve", "reject"]),
  /** A corrected attribute; the binding is then the reviewer's, not the model's. */
  attribute: AttributeName.optional(),
});

/** Approves or rejects items of a proposal. Approval is explicit, so it replaces conflicting bindings. */
export async function decideProposal(
  db: Db,
  actor: Actor,
  id: string,
  decisions: z.input<typeof ProposalDecisionInput>[],
): Promise<SemanticProposal> {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "build");
    const [p] = await db
      .select()
      .from(semanticProposals)
      .where(and(eq(semanticProposals.orgId, actor.orgId), eq(semanticProposals.id, id)));
    if (!p) throw new NotFoundError("Proposal");
    const graph = await loadSemanticGraph(db, actor.orgId);
    const o = graph.object(p.system, p.object);
    if (!o || o.entity !== p.entity)
      throw new InvalidStateError(`Bind ${p.object} to ${p.entity} before approving these bindings.`);
    const items = p.items.map((i) => ({ ...i }));
    let approved = 0;
    for (const d of z.array(ProposalDecisionInput).parse(decisions)) {
      const item = items.find((i) => i.field === d.field);
      if (!item) throw new NotFoundError("Proposal item");
      if (item.decision !== "pending") continue;
      if (d.decision === "approve") {
        const edited = d.attribute && d.attribute !== item.attribute;
        await setBinding(
          db,
          actor,
          {
            system: p.system,
            object: p.object,
            field: item.field,
            attribute: d.attribute ?? item.attribute,
            read: edited ? null : item.read,
            write: edited ? null : item.write,
          },
          edited
            ? { origin: "manual", proposalId: p.id, replace: true, quiet: true }
            : {
                origin: "ai",
                confidence: item.confidence,
                evidence: item.evidence,
                proposalId: p.id,
                replace: true,
                quiet: true,
              },
        );
        if (edited) item.attribute = d.attribute!;
        approved++;
      }
      item.decision = d.decision === "approve" ? "approved" : "rejected";
      item.decidedBy = actor.userId;
      item.decidedAt = new Date().toISOString();
    }
    const open = items.some((i) => i.decision === "pending");
    const [row] = await db
      .update(semanticProposals)
      .set({ items, status: open ? "open" : "closed", closedAt: open ? null : new Date() })
      .where(eq(semanticProposals.id, id))
      .returning();
    if (approved > 0)
      await changed(
        db,
        actor,
        p.system,
        p.object,
        `${approved} AI binding(s) for ${p.object} (${p.system}) were approved.`,
      );
    return row!;
  });
}

export async function listProposals(
  db: Db,
  actor: Actor,
  filter: { system?: string; object?: string; status?: "open" | "closed" } = {},
): Promise<SemanticProposal[]> {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "read");
    return db
      .select()
      .from(semanticProposals)
      .where(
        and(
          eq(semanticProposals.orgId, actor.orgId),
          filter.system ? eq(semanticProposals.system, filter.system) : undefined,
          filter.object ? eq(semanticProposals.object, filter.object) : undefined,
          filter.status ? eq(semanticProposals.status, filter.status) : undefined,
        ),
      )
      .orderBy(desc(semanticProposals.createdAt))
      .limit(100);
  });
}

// ── plans ─────────────────────────────────────────────────────────────────

/**
 * For an active integration: the objects whose bindings changed since its
 * plan was compiled. Runs keep using the plan until it is activated again.
 */
export async function semanticDrift(db: Db, actor: Actor, planId: string | null): Promise<string[]> {
  if (!planId) return [];
  return asTenant(db, actor.orgId, async (db) => {
    const [plan] = await db
      .select({ semantics: integrationPlans.semantics })
      .from(integrationPlans)
      .where(eq(integrationPlans.id, planId));
    const semantics = plan?.semantics as SemanticPlan | null | undefined;
    if (!semantics) return [];
    return staleObjects(semantics, await loadSemanticGraph(db, actor.orgId));
  });
}
