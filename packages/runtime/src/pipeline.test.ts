import { randomBytes, randomUUID } from "node:crypto";
import { type ConnectionConfig, closeAdapters, database } from "@oicr/adapters";
import {
  type Actor,
  activateIntegration,
  asTenant,
  createConnection,
  createDb,
  createInstance,
  createIntegration,
  createLookup,
  createProject,
  getInstance,
  type Integration,
  instances,
  listCheckpoints,
  listRejects,
  memberships,
  orgs,
  requeueStaleBatchRuns,
  saveCheckpoint,
  users,
} from "@oicr/db";
import { runMigrations } from "@oicr/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeInstance } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;
// The target is MySQL when one is available (a cross-database load), otherwise the same Postgres.
const targetUrl = process.env.ADAPTER_TEST_MYSQL ?? url;

const settings = (u: string) => {
  const p = new URL(u);
  return {
    properties: {
      dialect: p.protocol.startsWith("mysql") ? "mysql" : "postgres",
      host: p.hostname,
      port: Number(p.port) || undefined,
      database: decodeURIComponent(p.pathname.slice(1)),
      ssl: "disable",
    },
    secret: { username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) },
  };
};

describe.skipIf(!url)("batch pipelines (Postgres source, database target)", () => {
  const suffix = randomBytes(3).toString("hex");
  const src = `batch_src_${suffix}`;
  const dst = `batch_dst_${suffix}`;
  const source = settings(url!);
  const target = settings(targetUrl!);
  const asConn = (s: ReturnType<typeof settings>): ConnectionConfig => ({ ...s, authType: "basic" });
  const exec = (s: ReturnType<typeof settings>, sql: string) =>
    database.invoke(asConn(s), { operation: "execute", config: {}, request: { sql } });
  let actor: Actor;
  let projectId: string;

  const pipelineFlow = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    style: "application",
    trigger: { id: "t", type: "http", method: "POST", sync: false },
    steps: [
      {
        id: "load",
        type: "pipeline",
        source: {
          connection: "pg_src",
          operation: "read",
          config: { table: src, where: "status <> :skip", key: "id" },
          params: '{ "skip": $trigger.skip }',
        },
        filter: "$record.id % 1000 != 0",
        transform:
          '{ "id": id, "name": $uppercase(name), "country": $lookupValue("countries", "src", country, "dst", "??"), "batch": $trigger.batch }',
        target: { connection: "db_dst", operation: "upsert", config: { table: dst, key: "id" } },
        chunkSize: 250,
        concurrency: 3,
        maxRejects: 10,
        ...over,
      },
      { id: "done", type: "log", message: "loaded {{ $load.written }}" },
    ],
  });

  const activate = async (name: string, definition: unknown): Promise<Integration> => {
    const i = await createIntegration(db!, actor, { projectId, name, style: "application", definition });
    expect(i.validationErrors).toEqual([]);
    return activateIntegration(db!, actor, i.id, { tracingLevel: "debug" });
  };
  const queue = async (i: Integration, input: unknown) =>
    (await createInstance(db!, { orgId: i.orgId, integration: i, triggerKind: "manual", input })).instance;
  const count = async () => {
    const r = (await database.invoke(asConn(target), {
      operation: "query",
      config: {},
      request: { sql: `select count(*) as n from ${dst}` },
    })) as { rows: Record<string, unknown>[] };
    return Number(Object.values(r.rows[0]!)[0]);
  };

  beforeAll(async () => {
    process.env.SECRETS_KEY ??= randomBytes(32).toString("base64");
    process.env.ALLOW_PRIVATE_NETWORK = "true";
    process.env.BATCH_THREADS = "2";
    await runMigrations(url);
    const [u] = await db!
      .insert(users)
      .values({ name: "B", email: `batch-${randomUUID()}@example.com` })
      .returning();
    const [o] = await db!
      .insert(orgs)
      .values({ name: "B", slug: `batch-${randomUUID()}` })
      .returning();
    await db!.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
    actor = { userId: u!.id, orgId: o!.id, role: "admin" };
    projectId = (await createProject(db!, actor, { name: `Batch ${Date.now()}` })).id;

    await exec(
      source,
      `CREATE TABLE ${src} (id INTEGER PRIMARY KEY, name VARCHAR(100), country VARCHAR(2), status VARCHAR(1))`,
    );
    await exec(
      source,
      `INSERT INTO ${src} SELECT g, CASE WHEN g = 777 THEN 'a name that is much too long for the target column' ELSE 'customer ' || g END, CASE WHEN g % 2 = 0 THEN 'US' ELSE 'DE' END, CASE WHEN g % 500 = 1 THEN 'X' ELSE 'A' END FROM generate_series(1, 5000) g`,
    );
    await exec(
      target,
      `CREATE TABLE ${dst} (id INTEGER PRIMARY KEY, name VARCHAR(20), country VARCHAR(3), batch VARCHAR(10))`,
    );
    for (const [identifier, s] of [
      ["pg_src", source],
      ["db_dst", target],
    ] as const)
      await createConnection(db!, actor, {
        name: identifier,
        identifier,
        adapter: "database",
        authType: "basic",
        ...s,
      });
    await createLookup(db!, actor, { name: "countries", domains: ["src", "dst"], rows: [["US", "USA"]] });
  }, 120_000);

  afterAll(async () => {
    await exec(source, `DROP TABLE IF EXISTS ${src}`).catch(() => {});
    await exec(target, `DROP TABLE IF EXISTS ${dst}`).catch(() => {});
    await closeAdapters();
    await db?.$client.end();
  });

  it("loads in chunks on the batch lane, transforming on worker threads and setting rejects aside", async () => {
    const i = await activate(`Load ${suffix}`, pipelineFlow());
    const run = await queue(i, { skip: "X", batch: "B1" });
    expect(run.lane).toBe("batch");

    // Anywhere but the batch engine, the pipeline step refuses to run.
    const elsewhere = await executeInstance(db!, (await queue(i, { skip: "X", batch: "B0" })).id);
    expect(elsewhere.instance).toMatchObject({ status: "failed", errorCode: "batch_engine_required" });

    const { instance } = await executeInstance(db!, run.id, { batch: true });
    expect(instance.status).toBe("succeeded");
    const detail = await getInstance(db!, actor, run.id);
    // 5000 rows, 10 skipped by the source's where, 5 by the filter, 1 refused by the target.
    expect(detail.steps.find((s) => s.stepId === "load")?.output).toEqual({
      read: 4990,
      written: 4984,
      filtered: 5,
      rejected: 1,
      chunks: 20,
      resumed: false,
    });
    expect(detail.steps.find((s) => s.stepId === "done")?.message).toBe("loaded 4984");
    expect(await count()).toBe(4984);
    const rejects = await listRejects(db!, actor, run.id);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({ stage: "write", stepId: "load", code: "sql_error" });
    expect((rejects[0]!.record as { id: number }).id).toBe(777);
    expect((await listCheckpoints(db!, actor, run.id))[0]).toMatchObject({ status: "done", written: 4984 });

    // Running it again is idempotent: upserts by key.
    await executeInstance(db!, (await queue(i, { skip: "X", batch: "B2" })).id, { batch: true });
    expect(await count()).toBe(4984);
  }, 120_000);

  it("resumes after the last checkpoint, and puts stopped runs back on the queue", async () => {
    const i = await activate(`Resume ${suffix}`, pipelineFlow({ filter: undefined, maxRejects: 100 }));
    const run = await queue(i, { skip: "-", batch: "R" });
    // An earlier attempt got through 4000 records before its engine stopped.
    await saveCheckpoint(db!, run, "load", {
      cursor: 4000,
      read: 4000,
      written: 3999,
      filtered: 0,
      rejected: 1,
      chunks: 16,
    });
    await executeInstance(db!, run.id, { batch: true });
    const out = (await getInstance(db!, actor, run.id)).steps.find((s) => s.stepId === "load")?.output;
    expect(out).toEqual({ read: 5000, written: 4999, filtered: 0, rejected: 1, chunks: 20, resumed: true });

    // A batch run whose engine went quiet is queued again, then failed after too many attempts.
    const quiet = await queue(i, { skip: "-", batch: "Q" });
    await asTenant(db!, actor.orgId, (tx) =>
      tx
        .update(instances)
        .set({
          status: "running",
          startedAt: new Date(Date.now() - 600_000),
          heartbeatAt: new Date(Date.now() - 600_000),
        })
        .where(eq(instances.id, quiet.id)),
    );
    const first = await requeueStaleBatchRuns(db!, 120_000, 2);
    expect(first.requeued.map((r) => r.id)).toContain(quiet.id);
    const [again] = await asTenant(db!, actor.orgId, (tx) =>
      tx.select().from(instances).where(eq(instances.id, quiet.id)),
    );
    expect(again).toMatchObject({ status: "queued", attempts: 2 });
    await asTenant(db!, actor.orgId, (tx) =>
      tx
        .update(instances)
        .set({ status: "running", heartbeatAt: new Date(Date.now() - 600_000) })
        .where(eq(instances.id, quiet.id)),
    );
    expect((await requeueStaleBatchRuns(db!, 120_000, 2)).failed).toBeGreaterThanOrEqual(1);
    const [gone] = await asTenant(db!, actor.orgId, (tx) =>
      tx.select().from(instances).where(eq(instances.id, quiet.id)),
    );
    expect(gone).toMatchObject({ status: "failed", errorCode: "worker_lost" });
  }, 120_000);

  it("refuses pipelines that cannot run before activation", async () => {
    const bad = await createIntegration(db!, actor, {
      projectId,
      name: `Bad ${suffix}`,
      style: "application",
      definition: pipelineFlow({ target: { connection: "db_dst", operation: "upsert", config: { table: dst } } }),
    });
    expect(bad.status).toBe("draft");
    expect((bad.validationErrors as { message: string }[]).map((e) => e.message)).toEqual([
      expect.stringContaining('Upserts need "key"'),
    ]);
  });
});
