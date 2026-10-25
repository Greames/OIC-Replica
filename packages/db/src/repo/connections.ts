import { type AuthType, type ConnectionConfig, getAdapter, type TestResult } from "@oicr/adapters";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.js";
import { connections } from "../schema/runtime.js";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { type Actor, assertCan, ConflictError, NotFoundError } from "./access.js";

export const ConnectionInput = z.object({
  name: z.string().trim().min(1, "Give the connection a name.").max(100),
  identifier: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,49}$/, "Use lowercase letters, digits and _, starting with a letter (e.g. shop_api).")
    .optional(),
  projectId: z.string().uuid().nullable().optional(),
  adapter: z.string().min(1),
  role: z.enum(["trigger", "invoke", "trigger_invoke"]).default("invoke"),
  properties: z.record(z.string(), z.unknown()).default({}),
  authType: z.enum(["none", "basic", "api_key", "bearer"]).default("none"),
  /** Omit to keep the stored secret. null clears it. */
  secret: z.record(z.string(), z.string()).nullable().optional(),
});
export type ConnectionInput = z.input<typeof ConnectionInput>;

type Row = typeof connections.$inferSelect;

/** What leaves the server: never the secret, only whether one is stored. */
export type ConnectionView = Omit<Row, "secretCiphertext"> & { hasSecret: boolean };

function view(row: Row): ConnectionView {
  const { secretCiphertext, ...rest } = row;
  return { ...rest, hasSecret: secretCiphertext !== null };
}

/** "Shop API (prod)" → "shop_api_prod" */
export function toConnectionIdentifier(name: string): string {
  const id = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 50);
  return id || "connection";
}

function checkAdapter(input: z.infer<typeof ConnectionInput>) {
  const adapter = getAdapter(input.adapter);
  if (!adapter.authTypes.includes(input.authType as AuthType)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["authType"],
        message: `${adapter.name} does not support ${input.authType}.`,
        input: input.authType,
      },
    ]);
  }
  const props = adapter.properties.safeParse(input.properties);
  if (!props.success) {
    throw new z.ZodError(props.error.issues.map((i) => ({ ...i, path: ["properties", ...i.path] })));
  }
  return { adapter, properties: props.data as Record<string, unknown> };
}

export async function listConnections(
  db: Db,
  actor: Actor,
  opts: { projectId?: string } = {},
): Promise<ConnectionView[]> {
  assertCan(actor, "read");
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(eq(connections.orgId, actor.orgId), opts.projectId ? eq(connections.projectId, opts.projectId) : undefined),
    )
    .orderBy(asc(connections.name));
  return rows.map(view);
}

export async function getConnection(db: Db, actor: Actor, id: string): Promise<ConnectionView> {
  assertCan(actor, "read");
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.orgId, actor.orgId), eq(connections.id, id)));
  if (!row) throw new NotFoundError("Connection");
  return view(row);
}

export async function createConnection(db: Db, actor: Actor, input: ConnectionInput): Promise<ConnectionView> {
  assertCan(actor, "build");
  const data = ConnectionInput.parse(input);
  const { properties } = checkAdapter(data);
  const identifier = data.identifier ?? toConnectionIdentifier(data.name);
  const [row] = await db
    .insert(connections)
    .values({
      orgId: actor.orgId,
      projectId: data.projectId ?? null,
      name: data.name,
      identifier,
      adapter: data.adapter,
      role: data.role,
      properties,
      authType: data.authType,
      secretCiphertext: data.secret ? encryptSecret(data.secret) : null,
    })
    .onConflictDoNothing({ target: [connections.orgId, connections.identifier] })
    .returning();
  if (!row) throw new ConflictError(`A connection with the identifier ${identifier} already exists.`);
  return view(row);
}

export async function updateConnection(
  db: Db,
  actor: Actor,
  id: string,
  input: ConnectionInput,
): Promise<ConnectionView> {
  assertCan(actor, "build");
  const data = ConnectionInput.parse(input);
  const { properties } = checkAdapter(data);
  const [row] = await db
    .update(connections)
    .set({
      name: data.name,
      projectId: data.projectId ?? null,
      role: data.role,
      properties,
      authType: data.authType,
      ...(data.secret !== undefined ? { secretCiphertext: data.secret ? encryptSecret(data.secret) : null } : {}),
      status: "draft",
      lastTestError: null,
    })
    .where(and(eq(connections.orgId, actor.orgId), eq(connections.id, id)))
    .returning();
  if (!row) throw new NotFoundError("Connection");
  return view(row);
}

export async function deleteConnection(db: Db, actor: Actor, id: string): Promise<void> {
  assertCan(actor, "build");
  await db.delete(connections).where(and(eq(connections.orgId, actor.orgId), eq(connections.id, id)));
}

/** Runs the adapter's test and stores the outcome (S16 "Test"). */
export async function testConnection(db: Db, actor: Actor, id: string): Promise<TestResult> {
  assertCan(actor, "build");
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.orgId, actor.orgId), eq(connections.id, id)));
  if (!row) throw new NotFoundError("Connection");
  const result = await getAdapter(row.adapter).test(toConfig(row));
  await db
    .update(connections)
    .set({
      status: result.ok ? "configured" : "failed",
      lastTestedAt: new Date(),
      lastTestError: result.ok ? null : result.message,
    })
    .where(eq(connections.id, id));
  return result;
}

function toConfig(row: Row): ConnectionConfig {
  return {
    properties: row.properties,
    authType: row.authType,
    secret: row.secretCiphertext ? decryptSecret<Record<string, unknown>>(row.secretCiphertext) : null,
  };
}

/**
 * For the runtime only: the decrypted config of a connection, by identifier.
 * Never pass the result to the browser or the AI builder.
 */
export async function loadConnectionForRun(db: Db, orgId: string, identifier: string) {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.orgId, orgId), eq(connections.identifier, identifier)));
  if (!row) return null;
  return { adapter: row.adapter, role: row.role, config: toConfig(row) };
}

/** Identifier → role/adapter, for validating FlowDocs against what exists. */
export async function connectionIndex(db: Db, orgId: string) {
  const rows = await db
    .select({ identifier: connections.identifier, role: connections.role, adapter: connections.adapter })
    .from(connections)
    .where(eq(connections.orgId, orgId));
  return Object.fromEntries(rows.map((r) => [r.identifier, { role: r.role, adapter: r.adapter }]));
}
