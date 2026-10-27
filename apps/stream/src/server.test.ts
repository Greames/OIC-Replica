import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  type Actor,
  activateIntegration,
  createDb,
  createIntegration,
  createProject,
  createTriggerToken,
  deactivateIntegration,
  memberships,
  orgs,
  ROUTES_CHANNEL,
  setTenantLimits,
  users,
} from "@oicr/db";
import { runMigrations } from "@oicr/db/migrate";
import { stopQueue } from "@oicr/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStreamServer } from "./server.js";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;

describe.skipIf(!url)("stream engine", () => {
  let base: string;
  let stream: ReturnType<typeof createStreamServer>;

  async function tenant(name: string) {
    const [u] = await db!
      .insert(users)
      .values({ name, email: `${name}-${randomUUID()}@example.com` })
      .returning();
    const [o] = await db!
      .insert(orgs)
      .values({ name, slug: `${name}-${randomUUID().slice(0, 8)}` })
      .returning();
    await db!.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
    const actor: Actor = { userId: u!.id, orgId: o!.id, role: "admin" };
    const project = await createProject(db!, actor, { name: `${name} project` });
    return { actor, slug: o!.slug, projectId: project.id };
  }

  async function httpIntegration(t: Awaited<ReturnType<typeof tenant>>, name: string, steps: unknown[], sync = true) {
    const integ = await createIntegration(db!, t.actor, {
      projectId: t.projectId,
      name,
      style: "application",
      definition: {
        schemaVersion: 1,
        style: "application",
        trigger: { id: "t", type: "http", method: "POST", sync },
        steps,
      },
    });
    const active = await activateIntegration(db!, t.actor, integ.id, { tracingLevel: "production" });
    const token = await createTriggerToken(db!, t.actor, integ.id);
    return { integ: active, token, path: `/t/${t.slug}/${active.identifier}` };
  }

  const call = (path: string, token: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    await runMigrations(url);
    stream = createStreamServer({ db: db!, routeTtlMs: 60_000, missTtlMs: 60_000 });
    await db!.$client.listen(ROUTES_CHANNEL, (p) => stream.routes.invalidate(JSON.parse(p).integrationId));
    await new Promise<void>((r) => stream.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(stream.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await stream?.drain(1000);
    await stopQueue();
    await db?.$client.end();
  });

  it("answers health and readiness", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
  });

  it("runs a sync integration, refusing bad tokens, wrong paths and methods", async () => {
    const t = await tenant("acme");
    const { path, token } = await httpIntegration(t, "Echo", [
      { id: "r", type: "return", status: 201, body: '{ "hello": $trigger.name }' },
    ]);
    const ok = await call(path, token, { name: "Ada" });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ hello: "Ada" });
    expect(ok.headers.get("x-run-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call(path, `${token}x`)).status).toBe(401);
    expect((await call(`${path}/extra`, token)).status).toBe(404);
    expect((await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await call("/t/nobody/NOTHING", token)).status).toBe(404);
    const dup1 = await call(path, token, { name: "Bo" }, { "idempotency-key": "k-1" });
    const dup2 = await call(path, token, { name: "Bo" }, { "idempotency-key": "k-1" });
    expect(dup1.status).toBe(201);
    expect(await dup2.json()).toMatchObject({ duplicate: true, runId: dup1.headers.get("x-run-id") });
  });

  it("queues async integrations and refuses oversized bodies", async () => {
    const t = await tenant("queue");
    const { path, token } = await httpIntegration(t, "Async", [{ id: "l", type: "log", message: "hi" }], false);
    const r = await call(path, token, { a: 1 });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ status: "queued" });
    const big = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "x".repeat(10 * 1024 * 1024 + 1),
    });
    expect(big.status).toBe(413);
  });

  it("stops routing an integration as soon as it is deactivated", async () => {
    const t = await tenant("routes");
    const { integ, path, token } = await httpIntegration(t, "Routed", [{ id: "r", type: "return", body: '"ok"' }]);
    expect((await call(path, token)).status).toBe(200);
    await deactivateIntegration(db!, t.actor, integ.id);
    await expect.poll(async () => (await call(path, token)).status, { timeout: 3000 }).toBe(404);
    await activateIntegration(db!, t.actor, integ.id);
    await expect.poll(async () => (await call(path, token)).status, { timeout: 3000 }).toBe(200);
  });

  it("limits each tenant's request rate and concurrency without affecting others", async () => {
    const busy = await tenant("busy");
    const calm = await tenant("calm");
    await setTenantLimits(db!, busy.actor.orgId, { requestsPerSecond: 1, syncConcurrency: 1 });
    const slow = await httpIntegration(busy, "Slow", [
      { id: "w", type: "wait", seconds: 1 },
      { id: "r", type: "return", body: '"done"' },
    ]);
    const other = await httpIntegration(calm, "Other", [{ id: "r", type: "return", body: '"fine"' }]);

    // Three at once: a burst of 2 is allowed at 1 rps, and only 1 may run at a time.
    const replies = await Promise.all([1, 2, 3].map(() => call(slow.path, slow.token)));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    const refused = await Promise.all(
      replies
        .filter((r) => r.status === 429)
        .map(async (r) => ({ retry: r.headers.get("retry-after"), body: (await r.json()) as { error: string } })),
    );
    expect(refused.map((r) => r.body.error).sort()).toEqual(["rate_limited", "too_many_in_flight"]);
    expect(refused.every((r) => Number(r.retry) >= 1)).toBe(true);
    // Another tenant is unaffected.
    expect((await call(other.path, other.token)).status).toBe(200);
  });
});
