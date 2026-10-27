import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import type { Actor } from "./repo/access.js";
import { ConflictError, NotFoundError } from "./repo/access.js";
import { createProject, getProject, listProjects } from "./repo/projects.js";
import { memberships, orgs, users } from "./schema/auth.js";
import { projects } from "./schema/core.js";
import { asSystem, asTenant, refuse, rlsStatus, TenantScopeError } from "./tenancy.js";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;

describe.skipIf(!url)("tenant isolation (Postgres row-level security)", () => {
  let a: Actor;
  let b: Actor;

  const tenant = async (name: string): Promise<Actor> => {
    const [u] = await db!
      .insert(users)
      .values({ name, email: `${name}-${randomUUID()}@example.com` })
      .returning();
    const [o] = await db!
      .insert(orgs)
      .values({ name, slug: `${name}-${randomUUID()}` })
      .returning();
    await db!.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
    return { userId: u!.id, orgId: o!.id, role: "admin" };
  };

  beforeAll(async () => {
    await runMigrations(url);
    a = await tenant("alpha");
    b = await tenant("beta");
    await createProject(db!, a, { name: "Alpha orders" });
    await createProject(db!, b, { name: "Beta orders" });
  });
  afterAll(() => db?.$client.end());

  it("applies to this connection's role", async () => {
    expect(await rlsStatus(db!)).toMatchObject({ enforced: true });
  });

  it("shows each tenant only its own rows, even without a WHERE org_id", async () => {
    const seenByA = await asTenant(db!, a.orgId, (tx) => tx.select({ org: projects.orgId }).from(projects));
    expect(seenByA.length).toBeGreaterThan(0);
    expect(new Set(seenByA.map((r) => r.org))).toEqual(new Set([a.orgId]));
    const raw = await asTenant(db!, b.orgId, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from projects where org_id = ${a.orgId}`),
    );
    expect(raw[0]!.n).toBe(0);
  });

  it("returns nothing and accepts nothing outside a scope", async () => {
    expect(await db!.select().from(projects)).toEqual([]);
    await expect(
      db!.insert(projects).values({ orgId: a.orgId, name: "Sneaky", identifier: "SNEAKY" }),
    ).rejects.toThrow();
    const cause = await db!
      .insert(projects)
      .values({ orgId: a.orgId, name: "Sneaky", identifier: "SNEAKY" })
      .catch((e: { cause?: { message?: string } }) => e.cause?.message);
    expect(cause).toContain("row-level security");
  });

  it("refuses to write another tenant's rows from inside a scope", async () => {
    const write = asTenant(db!, b.orgId, (tx) =>
      tx.insert(projects).values({ orgId: a.orgId, name: "Cross", identifier: "CROSS" }),
    );
    await expect(write).rejects.toThrow();
    const moved = await asTenant(db!, b.orgId, (tx) =>
      tx.update(projects).set({ name: "Hijacked" }).where(sql`true`).returning({ org: projects.orgId }),
    );
    expect(moved.every((r) => r.org === b.orgId)).toBe(true);
  });

  it("blocks mixing tenants in one scope, and lets the platform's system jobs see all", async () => {
    await expect(asTenant(db!, a.orgId, (tx) => asTenant(tx, b.orgId, async () => 1))).rejects.toBeInstanceOf(
      TenantScopeError,
    );
    await expect(asTenant(db!, a.orgId, (tx) => asSystem(tx, "test", async () => 1))).rejects.toBeInstanceOf(
      TenantScopeError,
    );
    const orgsSeen = await asSystem(db!, "test", (tx) => tx.selectDistinct({ org: projects.orgId }).from(projects));
    expect(orgsSeen.map((r) => r.org)).toEqual(expect.arrayContaining([a.orgId, b.orgId]));
  });

  it("keeps repository calls inside the caller's tenant", async () => {
    const [alphaProject] = await listProjects(db!, a);
    await expect(getProject(db!, b, alphaProject!.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listProjects(db!, b)).every((p) => p.orgId === b.orgId)).toBe(true);
  });

  it("commits what a refusal recorded, and rolls back a plain error", async () => {
    const id = randomUUID().slice(0, 8).toUpperCase();
    await expect(
      asTenant(db!, a.orgId, async (tx) => {
        await tx.insert(projects).values({ orgId: a.orgId, name: "Kept", identifier: `KEPT_${id}` });
        return refuse(new ConflictError("refused after recording"));
      }),
    ).rejects.toThrow("refused after recording");
    await expect(
      asTenant(db!, a.orgId, async (tx) => {
        await tx.insert(projects).values({ orgId: a.orgId, name: "Gone", identifier: `GONE_${id}` });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const names = (await listProjects(db!, a)).map((p) => p.identifier);
    expect(names).toContain(`KEPT_${id}`);
    expect(names).not.toContain(`GONE_${id}`);
  });
  it("offboards a tenant: its secrets, then all its rows", async () => {
    const { memoryStore } = await import("@oicr/vault");
    const { useSecretStore, secretStore } = await import("./secret-store.js");
    const { offboardTenant } = await import("./offboard.js");
    const real = secretStore(db!);
    const store = memoryStore();
    useSecretStore(db!, store);
    try {
      const gone = await tenant("gamma");
      await createProject(db!, gone, { name: "Gamma" });
      await store.put({ tenant: gone.orgId, kind: "connection", id: "c1" }, { apiKey: "x" });
      await store.put({ tenant: a.orgId, kind: "connection", id: "c1" }, { apiKey: "keep" });
      expect(await offboardTenant(db!, gone.orgId)).toEqual({ secrets: 1, deleted: true });
      expect(
        await asSystem(db!, "test", (tx) => tx.select().from(projects).where(sql`org_id = ${gone.orgId}`)),
      ).toEqual([]);
      expect(await store.get({ tenant: a.orgId, kind: "connection", id: "c1" })).toEqual({ apiKey: "keep" });
    } finally {
      useSecretStore(db!, real);
    }
  });
});
