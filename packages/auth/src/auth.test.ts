import { createDb, createProject, listProjects, memberships } from "@oicr/db";
import { runMigrations } from "@oicr/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./index.js";

// Needs Postgres. Set TEST_DATABASE_URL (CI sets it); skipped otherwise.
const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;

describe.skipIf(!url)("auth + orgs + projects (Postgres)", () => {
  const auth = createAuth({ db: db!, baseURL: "http://localhost:3000", secret: "test-secret-test-secret-test-secret" });
  const email = `dev-${Date.now()}@example.com`;

  beforeAll(async () => {
    await runMigrations(url);
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  it("signs up, creates an org as admin, and scopes projects to it", async () => {
    const signUp = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "Dev" },
      returnHeaders: true,
    });
    const cookie = signUp.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("session_token");
    const headers = new Headers({ cookie: cookie.split(";")[0] ?? "" });
    const userId = signUp.response.user.id;
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);

    const org = await auth.api.createOrganization({
      body: { name: "Acme", slug: `acme-${Date.now()}` },
      headers,
    });
    expect(org?.id).toMatch(/^[0-9a-f-]{36}$/);

    const [member] = await db!.select().from(memberships).where(eq(memberships.userId, userId));
    expect(member?.role).toBe("admin");

    const actor = { userId, orgId: org!.id, role: "admin" as const };
    const p = await createProject(db!, actor, { name: "Orders sync (EU)" });
    expect(p.identifier).toBe("ORDERS_SYNC_EU");
    await expect(createProject(db!, actor, { name: "Orders sync EU" })).rejects.toThrow(/already exists/);

    const other = { ...actor, orgId: crypto.randomUUID() };
    expect(await listProjects(db!, other)).toEqual([]);
    expect((await listProjects(db!, actor)).map((x) => x.id)).toEqual([p.id]);

    await expect(createProject(db!, { ...actor, role: "viewer" }, { name: "Nope" })).rejects.toThrow(/cannot build/);
  });
});
