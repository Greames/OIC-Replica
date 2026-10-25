import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.js";
import { projects } from "../schema/core.js";
import { type Actor, assertCan, ConflictError, NotFoundError } from "./access.js";

export const NewProject = z.object({
  name: z.string().trim().min(1, "Give the project a name.").max(100),
  identifier: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,49}$/, "Use capitals, digits and _, starting with a letter (e.g. ORDERS_SYNC).")
    .optional(),
  description: z.string().max(2000).default(""),
});
export type NewProject = z.input<typeof NewProject>;
export type Project = typeof projects.$inferSelect;

/** "Orders sync (EU)" → "ORDERS_SYNC_EU" */
export function toIdentifier(name: string): string {
  const id = name
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .toUpperCase()
    .replace(/^[^A-Z]+/, "")
    .slice(0, 50);
  return id || "PROJECT";
}

export async function listProjects(db: Db, actor: Actor): Promise<Project[]> {
  assertCan(actor, "read");
  return db.select().from(projects).where(eq(projects.orgId, actor.orgId)).orderBy(desc(projects.updatedAt));
}

export async function getProject(db: Db, actor: Actor, id: string): Promise<Project> {
  assertCan(actor, "read");
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, actor.orgId), eq(projects.id, id)));
  if (!row) throw new NotFoundError("Project");
  return row;
}

export async function createProject(db: Db, actor: Actor, input: NewProject): Promise<Project> {
  assertCan(actor, "build");
  const data = NewProject.parse(input);
  const identifier = data.identifier ?? toIdentifier(data.name);
  const [row] = await db
    .insert(projects)
    .values({ ...data, identifier, orgId: actor.orgId, createdBy: actor.userId })
    .onConflictDoNothing({ target: [projects.orgId, projects.identifier] })
    .returning();
  if (!row) throw new ConflictError(`A project with the identifier ${identifier} already exists.`);
  return row;
}
