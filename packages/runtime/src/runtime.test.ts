import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Actor,
  activateIntegration,
  claimDueSchedules,
  createConnection,
  createDb,
  createIntegration,
  createLookup,
  createProject,
  deleteLookup,
  failStaleInstances,
  getInstance,
  getSamples,
  getTriggerToken,
  instances,
  listInstances,
  memberships,
  orgs,
  saveDefinition,
  schedules,
  setSample,
  setSchedule,
  testConnection,
  updateLookup,
  users,
} from "@oicr/db";
import { runMigrations } from "@oicr/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeInstance, startRun } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;

describe.skipIf(!url)("runtime (Postgres + mock API)", () => {
  let server: Server;
  let base: string;
  const received: unknown[] = [];
  let actor: Actor;
  let projectId: string;

  beforeAll(async () => {
    process.env.SECRETS_KEY = randomBytes(32).toString("base64");
    process.env.ALLOW_PRIVATE_NETWORK = "true";
    await runMigrations(url);
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.headers["x-api-key"] !== "k-123") return res.writeHead(401).end();
        if (req.url === "/health") return res.writeHead(200).end("ok");
        if (req.url === "/orders" && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              orders: [
                { id: "A1", total: 10 },
                { id: "A2", total: -1 },
              ],
            }),
          );
        }
        if (req.url === "/shop/orders" && req.method === "POST") {
          const parsed = JSON.parse(body);
          received.push(parsed);
          if (parsed.total_cents < 0) {
            res.writeHead(422, { "content-type": "application/json" });
            return res.end('{"error":"negative total"}');
          }
          res.writeHead(201, { "content-type": "application/json" });
          return res.end(JSON.stringify({ shopId: `S-${parsed.external_id}` }));
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const [u] = await db!
      .insert(users)
      .values({ name: "T", email: `rt-${randomUUID()}@example.com` })
      .returning();
    const [o] = await db!
      .insert(orgs)
      .values({ name: "RT", slug: `rt-${randomUUID()}` })
      .returning();
    await db!.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
    actor = { userId: u!.id, orgId: o!.id, role: "admin" };
    projectId = (await createProject(db!, actor, { name: `Runtime ${Date.now()}` })).id;
  });

  afterAll(async () => {
    server?.close();
    await db?.$client.end();
  });

  it("creates and tests a connection without exposing the secret", async () => {
    const c = await createConnection(db!, actor, {
      name: "Mock API",
      identifier: "mock_api",
      adapter: "rest",
      properties: { baseUrl: base, testPath: "/health" },
      authType: "api_key",
      secret: { apiKey: "k-123" },
    });
    expect(c.hasSecret).toBe(true);
    expect(JSON.stringify(c)).not.toContain("k-123");
    expect(await testConnection(db!, actor, c.id)).toMatchObject({ ok: true });

    const bad = await createConnection(db!, actor, {
      name: "Bad key",
      adapter: "rest",
      properties: { baseUrl: base, testPath: "/health" },
      authType: "api_key",
      secret: { apiKey: "wrong" },
    });
    expect(bad.identifier).toBe("bad_key");
    expect((await testConnection(db!, actor, bad.id)).ok).toBe(false);
  });

  it("refuses bad connection settings with a readable message", async () => {
    await expect(
      createConnection(db!, actor, { name: "x", adapter: "rest", properties: { baseUrl: "nope" } }),
    ).rejects.toThrow(/full URL/);
  });

  it("builds, activates and runs a scheduled integration, recording each step", async () => {
    const integ = await createIntegration(db!, actor, { projectId, name: "Orders to shop", style: "scheduled" });
    expect(integ.status).toBe("draft");
    expect(integ.identifier).toBe("ORDERS_TO_SHOP");

    const definition = {
      schemaVersion: 1,
      style: "scheduled",
      trigger: { id: "t", type: "schedule" },
      steps: [
        { id: "get", type: "invoke", connection: "mock_api", operation: "GET /orders" },
        {
          id: "each",
          type: "forEach",
          over: "$get.body.orders",
          as: "order",
          steps: [
            {
              id: "sc",
              type: "scope",
              steps: [
                {
                  id: "post",
                  type: "invoke",
                  connection: "mock_api",
                  operation: "POST /shop/orders",
                  request: '{ "body": { "external_id": $order.id, "total_cents": $order.total * 100 } }',
                },
              ],
              onFault: [{ id: "note", type: "log", message: "order {{$order.id}} failed: {{$fault.code}}" }],
            },
          ],
        },
      ],
      businessIds: [{ name: "first", expr: "$get.body.orders[0].id", primary: true }],
    };

    const unknownConn = await saveDefinition(
      db!,
      actor,
      integ.id,
      { ...definition, steps: [{ ...definition.steps[0], connection: "nope" }] },
      integ.definitionHash,
    );
    expect(unknownConn.errors.map((e) => e.code)).toContain("unknown_connection");
    expect(unknownConn.integration.status).toBe("draft");

    await expect(saveDefinition(db!, actor, integ.id, definition, integ.definitionHash)).rejects.toThrow(
      /changed since you opened/,
    );
    const saved = await saveDefinition(db!, actor, integ.id, definition, unknownConn.integration.definitionHash);
    expect(saved.errors).toEqual([]);
    expect(saved.integration.status).toBe("configured");

    await expect(activateIntegration(db!, actor, integ.id)).rejects.toThrow(/Set a schedule/);
    await expect(setSchedule(db!, actor, integ.id, { kind: "interval", expression: "PT10S" })).rejects.toThrow(
      /shortest interval/,
    );
    await setSchedule(db!, actor, integ.id, { kind: "interval", expression: "PT15M" });
    const active = await activateIntegration(db!, actor, integ.id, { tracingLevel: "debug" });
    expect(active.status).toBe("active");
    await expect(saveDefinition(db!, actor, integ.id, definition, active.definitionHash)).rejects.toThrow(/Deactivate/);

    // The scheduler claims it once it is due, exactly once.
    await db!
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(schedules.integrationId, integ.id));
    const [a, b] = await Promise.all([claimDueSchedules(db!), claimDueSchedules(db!)]);
    const claimed = [...a, ...b].filter((x) => x.integration.id === integ.id);
    expect(claimed).toHaveLength(1);
    const [sched] = await db!.select().from(schedules).where(eq(schedules.integrationId, integ.id));
    expect(sched!.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    // Queue path is the worker's job; here we create and execute directly.
    received.length = 0;
    const run = await startRun(db!, active, { input: {}, kind: "manual", sync: true });
    expect(run.status).toBe("succeeded");
    expect(received).toEqual([
      { external_id: "A1", total_cents: 1000 },
      { external_id: "A2", total_cents: -100 },
    ]);

    const detail = await getInstance(db!, actor, run.instanceId);
    expect(detail.primaryBusinessId).toBe("A1");
    expect(detail.steps.map((s) => [s.stepId, s.status, s.iteration])).toEqual([
      ["get", "succeeded", null],
      ["each", "succeeded", null],
      ["sc", "succeeded", 0],
      ["post", "succeeded", 0],
      ["sc", "succeeded", 1],
      ["post", "failed", 1],
      ["note", "succeeded", 1],
    ]);
    expect(detail.steps[3]?.output).toMatchObject({ status: 201, body: { shopId: "S-A1" } });
    expect(detail.steps[5]?.message).toContain("negative total");
    expect(detail.steps[6]?.message).toBe("order A2 failed: http_422");

    const list = await listInstances(db!, actor, { integrationId: integ.id });
    expect(list.items[0]?.id).toBe(run.instanceId);
    expect((await listInstances(db!, actor, { businessId: "A1" })).items).toHaveLength(1);
    expect((await listInstances(db!, { ...actor, orgId: randomUUID() })).items).toHaveLength(0);
  });

  it("runs a sync application integration, returns its response, and dedupes by idempotency key", async () => {
    const integ = await createIntegration(db!, actor, {
      projectId,
      name: "Echo",
      style: "application",
      definition: {
        schemaVersion: 1,
        style: "application",
        trigger: { id: "t", type: "http", method: "POST", sync: true },
        steps: [{ id: "r", type: "return", status: 200, body: '{ "hello": $trigger.name }' }],
      },
    });
    const active = await activateIntegration(db!, actor, integ.id, { tracingLevel: "production" });
    expect(await getTriggerToken(db!, actor, integ.id)).toMatch(/^oicr_t_/);

    const r1 = await startRun(db!, active, {
      input: { name: "Ada" },
      kind: "request",
      sync: true,
      idempotencyKey: "k1",
    });
    expect(r1.response).toEqual({ status: 200, body: { hello: "Ada" } });
    const r2 = await startRun(db!, active, {
      input: { name: "Ada" },
      kind: "request",
      sync: true,
      idempotencyKey: "k1",
    });
    expect(r2).toMatchObject({ duplicate: true, instanceId: r1.instanceId });

    // production tracing keeps no payloads for successful steps
    const detail = await getInstance(db!, actor, r1.instanceId);
    expect(detail.steps[0]?.output).toBeNull();
  });

  it("explains credentials that can no longer be decrypted", async () => {
    const integ = await createIntegration(db!, actor, {
      projectId,
      name: "Key rotation",
      style: "application",
      definition: {
        schemaVersion: 1,
        style: "application",
        trigger: { id: "t", type: "http", sync: true },
        steps: [{ id: "get", type: "invoke", connection: "mock_api", operation: "GET /orders" }],
      },
    });
    const active = await activateIntegration(db!, actor, integ.id);
    const original = process.env.SECRETS_KEY;
    process.env.SECRETS_KEY = randomBytes(32).toString("base64");
    try {
      const r = await startRun(db!, active, { input: {}, kind: "manual", sync: true });
      expect(r.error?.code).toBe("secret_unreadable");
      expect(r.error?.message).toContain("enter them again");
    } finally {
      process.env.SECRETS_KEY = original;
    }
  });

  it("does not run an instance twice and fails stale runs", async () => {
    const [row] = await db!.select().from(instances).limit(1);
    const again = await executeInstance(db!, row!.id);
    expect(again.result).toBeNull();

    await db!
      .update(instances)
      .set({ status: "running", startedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(instances.id, row!.id));
    expect(await failStaleInstances(db!, 600_000)).toBeGreaterThanOrEqual(1);
    const [after] = await db!.select().from(instances).where(eq(instances.id, row!.id));
    expect(after?.errorCode).toBe("worker_lost");
  });
  it("translates with lookups at run time, guards lookups in use, and gives the mapper samples", async () => {
    await expect(
      createLookup(db!, actor, {
        name: "codes",
        domains: ["shop", "erp"],
        rows: [
          ["A", "1"],
          ["A", "2"],
        ],
      }),
    ).rejects.toThrow(/is in shop twice \(rows 1 and 2\)/);
    await expect(createLookup(db!, actor, { name: "codes", domains: ["shop"], rows: [] })).rejects.toThrow(
      /at least two/,
    );
    const lookup = await createLookup(db!, actor, {
      name: "codes",
      domains: ["shop", "erp"],
      rows: [
        ["A1", "ERP-1", "extra"],
        ["", ""],
        ["A2", "ERP-2"],
      ],
    });
    expect(lookup.rows).toEqual([
      ["A1", "ERP-1"],
      ["A2", "ERP-2"],
    ]);
    await expect(createLookup(db!, actor, { name: "codes", domains: ["a", "b"], rows: [] })).rejects.toThrow(
      /already exists/,
    );

    const integ = await createIntegration(db!, actor, { projectId, name: "Lookup run", style: "application" });
    const definition = {
      schemaVersion: 1,
      style: "application",
      trigger: { id: "t", type: "http", sync: true },
      steps: [
        { id: "get", type: "invoke", connection: "mock_api", operation: "GET /orders" },
        {
          id: "m",
          type: "map",
          expression: '{ "erp": $lookupValue("codes", "shop", $get.body.orders.id, "erp", "?") }',
        },
        { id: "r", type: "return", body: "$m" },
      ],
    };
    const bad = await saveDefinition(
      db!,
      actor,
      integ.id,
      { ...definition, steps: [{ id: "m", type: "map", expression: '$lookupValue("nope", "a", 1, "b")' }] },
      integ.definitionHash,
    );
    expect(bad.errors.map((e) => e.code)).toContain("unknown_lookup");
    const saved = await saveDefinition(db!, actor, integ.id, definition, bad.integration.definitionHash);
    expect(saved.errors).toEqual([]);
    const active = await activateIntegration(db!, actor, integ.id);
    const run = await startRun(db!, active, { input: { hello: "world" }, kind: "manual", sync: true });
    expect(run.response?.body).toEqual({ erp: ["ERP-1", "ERP-2"] });

    await expect(deleteLookup(db!, actor, lookup.id)).rejects.toThrow(/used by active integration/);
    await expect(
      updateLookup(db!, actor, lookup.id, { name: "renamed", domains: ["shop", "erp"], rows: [] }),
    ).rejects.toThrow(/Renaming it would break/);
    await updateLookup(db!, actor, lookup.id, { name: "codes", domains: ["shop", "erp"], rows: [["A1", "X"]] });

    const samples = await getSamples(db!, actor, integ.id);
    expect(samples.run.trigger).toEqual({ hello: "world" });
    expect(samples.run.steps.m).toEqual({ erp: ["ERP-1", "ERP-2"] });
    await setSample(db!, actor, integ.id, "get", { body: { orders: [] } });
    expect((await getSamples(db!, actor, integ.id)).pasted).toEqual({ get: { body: { orders: [] } } });
    await setSample(db!, actor, integ.id, "get", null);
    expect((await getSamples(db!, actor, integ.id)).pasted).toEqual({});
  });
});
