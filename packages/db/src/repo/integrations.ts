import { randomBytes } from "node:crypto";
import { emptyFlow, type FlowDoc, hashFlow, type Issue, validateFlow } from "@oicr/flow-schema";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.js";
import { nextRunAfter, ScheduleInput } from "../schedule.js";
import { orgs } from "../schema/auth.js";
import { projects } from "../schema/core.js";
import { integrations, schedules } from "../schema/runtime.js";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { type Actor, assertCan, ConflictError, NotFoundError } from "./access.js";
import { connectionIndex } from "./connections.js";
import { toIdentifier } from "./projects.js";

export type Integration = typeof integrations.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;

export const NewIntegration = z.object({
  projectId: z.string().uuid("Pick a project."),
  name: z.string().trim().min(1, "Give the integration a name.").max(100),
  identifier: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,49}$/, "Use capitals, digits and _, starting with a letter (e.g. ORDERS_TO_SHOP).")
    .optional(),
  style: z.enum(["application", "scheduled"]),
  definition: z.unknown().optional(),
});
export type NewIntegration = z.input<typeof NewIntegration>;

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

/** Validates against the org's real connections; empty flows stay drafts. */
async function check(db: Db, orgId: string, definition: unknown) {
  const result = validateFlow(definition, { connections: await connectionIndex(db, orgId) });
  const doc = result.doc ?? (definition as FlowDoc);
  const hasSteps = Array.isArray((definition as FlowDoc)?.steps) && (definition as FlowDoc).steps.length > 0;
  return {
    definition: doc,
    hash: await hashFlow(doc),
    errors: result.errors as Issue[],
    warnings: result.warnings,
    status: (result.ok && hasSteps ? "configured" : "draft") as "configured" | "draft",
  };
}

export async function listIntegrations(db: Db, actor: Actor, opts: { projectId?: string } = {}) {
  assertCan(actor, "read");
  return db
    .select({
      id: integrations.id,
      name: integrations.name,
      identifier: integrations.identifier,
      version: integrations.version,
      style: integrations.style,
      status: integrations.status,
      projectId: integrations.projectId,
      projectName: projects.name,
      updatedAt: integrations.updatedAt,
      activatedAt: integrations.activatedAt,
    })
    .from(integrations)
    .innerJoin(projects, eq(projects.id, integrations.projectId))
    .where(
      and(eq(integrations.orgId, actor.orgId), opts.projectId ? eq(integrations.projectId, opts.projectId) : undefined),
    )
    .orderBy(desc(integrations.updatedAt));
}

export async function getIntegration(db: Db, actor: Actor, id: string) {
  assertCan(actor, "read");
  const [row] = await db
    .select({ integration: integrations, projectName: projects.name, schedule: schedules })
    .from(integrations)
    .innerJoin(projects, eq(projects.id, integrations.projectId))
    .leftJoin(schedules, eq(schedules.integrationId, integrations.id))
    .where(and(eq(integrations.orgId, actor.orgId), eq(integrations.id, id)));
  if (!row) throw new NotFoundError("Integration");
  return { ...row.integration, projectName: row.projectName, schedule: row.schedule };
}

export async function createIntegration(db: Db, actor: Actor, input: NewIntegration): Promise<Integration> {
  assertCan(actor, "build");
  const data = NewIntegration.parse(input);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, data.projectId)));
  if (!project) throw new NotFoundError("Project");

  const checked = await check(db, actor.orgId, data.definition ?? emptyFlow(data.style));
  const identifier = data.identifier ?? toIdentifier(data.name);
  const [row] = await db
    .insert(integrations)
    .values({
      orgId: actor.orgId,
      projectId: data.projectId,
      name: data.name,
      identifier,
      style: data.style,
      definition: checked.definition,
      definitionHash: checked.hash,
      validationErrors: checked.errors,
      status: checked.status,
      createdBy: actor.userId,
    })
    .onConflictDoNothing({ target: [integrations.orgId, integrations.identifier, integrations.version] })
    .returning();
  if (!row) throw new ConflictError(`An integration with the identifier ${identifier} already exists.`);
  return row;
}

/**
 * Saves a FlowDoc (S06). `baseHash` must match what the editor loaded, or the
 * save is refused (someone else, or the AI, changed it meanwhile).
 * Invalid documents are saved as drafts with their errors, so work is never lost.
 */
export async function saveDefinition(db: Db, actor: Actor, id: string, definition: unknown, baseHash: string) {
  assertCan(actor, "build");
  const current = await getIntegration(db, actor, id);
  if (current.status === "active") {
    throw new InvalidStateError("Deactivate the integration before editing it.");
  }
  if (current.definitionHash !== baseHash) {
    throw new ConflictError("This integration changed since you opened it. Reload to see the latest version.");
  }
  const checked = await check(db, actor.orgId, definition);
  if ((definition as FlowDoc)?.style !== current.style) {
    checked.errors.unshift({
      code: "schema",
      message: `This is a ${current.style} integration; "style" must stay "${current.style}".`,
      path: ["style"],
    });
    checked.status = "draft";
  }
  const [row] = await db
    .update(integrations)
    .set({
      definition: checked.definition,
      definitionHash: checked.hash,
      validationErrors: checked.errors,
      status: checked.status,
    })
    .where(and(eq(integrations.orgId, actor.orgId), eq(integrations.id, id)))
    .returning();
  return { integration: row!, errors: checked.errors, warnings: checked.warnings };
}

export async function setSchedule(
  db: Db,
  actor: Actor,
  integrationId: string,
  input: ScheduleInput,
): Promise<Schedule> {
  assertCan(actor, "build");
  const s = ScheduleInput.parse(input);
  const integration = await getIntegration(db, actor, integrationId);
  if (integration.style !== "scheduled") throw new InvalidStateError("Only scheduled integrations have a schedule.");
  const nextRunAt = integration.status === "active" ? nextRunAfter(s, new Date()) : null;
  const [row] = await db
    .insert(schedules)
    .values({ orgId: actor.orgId, integrationId, ...s, nextRunAt })
    .onConflictDoUpdate({ target: schedules.integrationId, set: { ...s, nextRunAt, status: "active" } })
    .returning();
  return row!;
}

export async function activateIntegration(
  db: Db,
  actor: Actor,
  id: string,
  opts: { tracingLevel?: "production" | "audit" | "debug" } = {},
): Promise<Integration> {
  assertCan(actor, "operate");
  const current = await getIntegration(db, actor, id);
  if (current.status === "active") return current;
  // Re-validate: connections may have changed since the last save.
  const checked = await check(db, actor.orgId, current.definition);
  if (checked.errors.length > 0 || checked.status !== "configured") {
    await db
      .update(integrations)
      .set({ validationErrors: checked.errors, status: "draft" })
      .where(eq(integrations.id, id));
    throw new InvalidStateError(
      checked.errors.length > 0
        ? `Fix ${checked.errors.length} problem(s) before activating: ${checked.errors[0]?.message}`
        : "Add at least one step before activating.",
    );
  }
  if (current.style === "scheduled" && !current.schedule)
    throw new InvalidStateError("Set a schedule before activating.");

  const token =
    current.style === "application" && !current.triggerTokenCiphertext ? encryptSecret(newTriggerToken()) : undefined;
  const [row] = await db
    .update(integrations)
    .set({
      status: "active",
      activatedAt: new Date(),
      activatedBy: actor.userId,
      tracingLevel: opts.tracingLevel ?? current.tracingLevel,
      ...(token ? { triggerTokenCiphertext: token } : {}),
    })
    .where(eq(integrations.id, id))
    .returning();
  if (current.schedule) {
    await db
      .update(schedules)
      .set({ status: "active", nextRunAt: nextRunAfter(current.schedule, new Date()) })
      .where(eq(schedules.id, current.schedule.id));
  }
  return row!;
}

export async function deactivateIntegration(db: Db, actor: Actor, id: string): Promise<Integration> {
  assertCan(actor, "operate");
  const current = await getIntegration(db, actor, id);
  const [row] = await db
    .update(integrations)
    .set({ status: current.validationErrors.length === 0 ? "configured" : "draft" })
    .where(eq(integrations.id, id))
    .returning();
  if (current.schedule)
    await db.update(schedules).set({ nextRunAt: null }).where(eq(schedules.id, current.schedule.id));
  return row!;
}

function newTriggerToken(): string {
  return `oicr_t_${randomBytes(24).toString("base64url")}`;
}

/** The token callers send as `Authorization: Bearer ...` to the trigger URL. */
export async function getTriggerToken(db: Db, actor: Actor, id: string): Promise<string | null> {
  assertCan(actor, "build");
  const current = await getIntegration(db, actor, id);
  return current.triggerTokenCiphertext ? decryptSecret<string>(current.triggerTokenCiphertext) : null;
}

export async function regenerateTriggerToken(db: Db, actor: Actor, id: string): Promise<string> {
  assertCan(actor, "operate");
  await getIntegration(db, actor, id);
  const token = newTriggerToken();
  await db
    .update(integrations)
    .set({ triggerTokenCiphertext: encryptSecret(token) })
    .where(eq(integrations.id, id));
  return token;
}

/** For the trigger endpoint: the active integration behind /t/{org}/{identifier}. */
export async function findActiveTrigger(db: Db, orgSlug: string, identifier: string) {
  const [row] = await db
    .select({ integration: integrations })
    .from(integrations)
    .innerJoin(orgs, eq(orgs.id, integrations.orgId))
    .where(and(eq(orgs.slug, orgSlug), eq(integrations.identifier, identifier), eq(integrations.status, "active")));
  if (!row) return null;
  const token = row.integration.triggerTokenCiphertext
    ? decryptSecret<string>(row.integration.triggerTokenCiphertext)
    : null;
  return { integration: row.integration, token };
}
