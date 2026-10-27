import type { LookupTable } from "@oicr/flow-schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.js";
import { lookups } from "../schema/lookups.js";
import { integrations } from "../schema/runtime.js";
import { type Actor, assertCan, ConflictError, NotFoundError } from "./access.js";
import { InvalidStateError } from "./integrations.js";

export type Lookup = typeof lookups.$inferSelect;

/**
 * A lookup as the editor sends it. Rows are padded to the number of domains,
 * fully empty rows are dropped, and the first domain is the key: every row
 * needs a value there, and no value may repeat.
 */
export const LookupInput = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, "Use letters, digits, _ and -, starting with a letter (e.g. countries)."),
    description: z.string().trim().max(500).nullish(),
    domains: z
      .array(z.string().trim().min(1, "Name every domain.").max(60))
      .min(2, "A lookup needs at least two domains (columns).")
      .max(20),
    rows: z.array(z.array(z.string().max(1000)).max(20)).max(20_000),
  })
  .transform((v) => ({
    ...v,
    rows: v.rows.map((r) => v.domains.map((_, i) => (r[i] ?? "").trim())).filter((r) => r.some((c) => c !== "")),
  }))
  .superRefine((v, ctx) => {
    const seen = new Map<string, number>();
    v.domains.forEach((d, i) => {
      const k = d.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["domains", i], message: `Domain "${d}" is there twice.` });
      seen.set(k, i);
    });
    const keys = new Map<string, number>();
    v.rows.forEach((r, i) => {
      const key = r[0]!;
      if (!key) {
        ctx.addIssue({ code: "custom", path: ["rows", i, 0], message: `Row ${i + 1} has no ${v.domains[0]} value.` });
        return;
      }
      const prev = keys.get(key);
      if (prev !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["rows", i, 0],
          message: `"${key}" is in ${v.domains[0]} twice (rows ${prev + 1} and ${i + 1}).`,
        });
      else keys.set(key, i);
    });
  });
export type LookupInput = z.input<typeof LookupInput>;

export async function listLookups(db: Db, actor: Actor) {
  assertCan(actor, "read");
  return db
    .select({
      id: lookups.id,
      name: lookups.name,
      description: lookups.description,
      domains: lookups.domains,
      rowCount: sql<number>`jsonb_array_length(${lookups.rows})`.mapWith(Number),
      updatedAt: lookups.updatedAt,
    })
    .from(lookups)
    .where(eq(lookups.orgId, actor.orgId))
    .orderBy(asc(lookups.name));
}

export async function lookupNames(db: Db, orgId: string): Promise<string[]> {
  const rows = await db.select({ name: lookups.name }).from(lookups).where(eq(lookups.orgId, orgId));
  return rows.map((r) => r.name);
}

export async function getLookup(db: Db, actor: Actor, id: string): Promise<Lookup> {
  assertCan(actor, "read");
  const [row] = await db
    .select()
    .from(lookups)
    .where(and(eq(lookups.orgId, actor.orgId), eq(lookups.id, id)));
  if (!row) throw new NotFoundError("Lookup");
  return row;
}

/** For the runtime: a lookup by name in an org, or null. */
export async function loadLookup(db: Db, orgId: string, name: string): Promise<LookupTable | null> {
  const [row] = await db
    .select({ name: lookups.name, domains: lookups.domains, rows: lookups.rows })
    .from(lookups)
    .where(and(eq(lookups.orgId, orgId), eq(lookups.name, name)));
  return row ?? null;
}

const usesLookup = (definition: unknown, name: string) =>
  new RegExp(`\\$lookupValue\\(\\s*\\\\?["']${name.replace(/[-]/g, "\\-")}\\\\?["']`).test(JSON.stringify(definition));

/** Integrations whose definition calls $lookupValue("name", ...). */
export async function lookupUsage(db: Db, orgId: string, name: string) {
  const rows = await db
    .select({
      id: integrations.id,
      name: integrations.name,
      status: integrations.status,
      definition: integrations.definition,
    })
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), sql`${integrations.definition}::text like ${`%${name}%`}`));
  return rows.filter((r) => usesLookup(r.definition, name)).map(({ definition: _d, ...r }) => r);
}

const unique = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } }).code === "23505" ||
  (e as { cause?: { code?: string } }).cause?.code === "23505";

export async function createLookup(db: Db, actor: Actor, input: LookupInput): Promise<Lookup> {
  assertCan(actor, "build");
  const data = LookupInput.parse(input);
  try {
    const [row] = await db
      .insert(lookups)
      .values({ orgId: actor.orgId, ...data, description: data.description ?? null, createdBy: actor.userId })
      .returning();
    return row!;
  } catch (e) {
    if (unique(e)) throw new ConflictError(`A lookup named "${data.name}" already exists.`);
    throw e;
  }
}

export async function updateLookup(db: Db, actor: Actor, id: string, input: LookupInput): Promise<Lookup> {
  assertCan(actor, "build");
  const data = LookupInput.parse(input);
  const current = await getLookup(db, actor, id);
  if (data.name !== current.name) {
    const used = await lookupUsage(db, actor.orgId, current.name);
    if (used.length)
      throw new InvalidStateError(
        `"${current.name}" is used by ${used.map((u) => u.name).join(", ")}. Renaming it would break them.`,
      );
  }
  try {
    const [row] = await db
      .update(lookups)
      .set({ ...data, description: data.description ?? null, updatedAt: new Date() })
      .where(and(eq(lookups.orgId, actor.orgId), eq(lookups.id, id)))
      .returning();
    return row!;
  } catch (e) {
    if (unique(e)) throw new ConflictError(`A lookup named "${data.name}" already exists.`);
    throw e;
  }
}

export async function deleteLookup(db: Db, actor: Actor, id: string): Promise<void> {
  assertCan(actor, "build");
  const current = await getLookup(db, actor, id);
  const active = (await lookupUsage(db, actor.orgId, current.name)).filter((u) => u.status === "active");
  if (active.length)
    throw new InvalidStateError(
      `"${current.name}" is used by active integration(s): ${active.map((u) => u.name).join(", ")}. Deactivate them first.`,
    );
  await db.delete(lookups).where(and(eq(lookups.orgId, actor.orgId), eq(lookups.id, id)));
}
