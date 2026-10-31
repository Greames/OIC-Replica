import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectionConfig } from "../types.js";
import { database, dbError } from "./index.js";
import {
  bindNamed,
  columnsFor,
  keyOf,
  keysetPage,
  multiRowWrite,
  oracleWrite,
  readConfig,
  toBindValue,
  writeConfig,
} from "./sql.js";

describe("database SQL", () => {
  it("binds :name parameters per dialect, leaving strings, comments and casts alone", () => {
    const sql = "select ':x' as s, a::text /* :y */ from t -- :z\nwhere a = :a and b = :b or a = :a";
    expect(bindNamed(sql, { a: 1, b: "two" }, "postgres")).toEqual({
      text: "select ':x' as s, a::text /* :y */ from t -- :z\nwhere a = $1 and b = $2 or a = $1",
      values: [1, "two"],
    });
    expect(bindNamed("x = :a and y = :a", { a: 1 }, "mysql")).toEqual({ text: "x = ? and y = ?", values: [1, 1] });
    expect(bindNamed("x = :a", { a: { k: 1 } }, "oracle")).toEqual({ text: "x = :a", values: { a: '{"k":1}' } });
    expect(() => bindNamed("x = :missing", {}, "postgres")).toThrow(/no parameter "missing"/);
    expect(toBindValue("2026-01-05T10:00:00Z")).toBeInstanceOf(Date);
    expect(toBindValue("2026-01-05")).toBe("2026-01-05");
  });

  it("pages through a source by key, in each dialect's syntax", () => {
    const cfg = readConfig({ table: "ar.hz_cust_accounts", where: "status = :status", key: "cust_account_id" });
    expect(keysetPage("postgres", cfg, { status: "A" }, null, 500)).toEqual({
      text: "SELECT q.* FROM (SELECT * FROM ar.hz_cust_accounts WHERE status = $1) q ORDER BY q.cust_account_id LIMIT $2",
      values: ["A", 500],
    });
    expect(keysetPage("oracle", readConfig({ sql: "select * from t;", key: "ID" }), {}, 42, 100)).toEqual({
      text: "SELECT q.* FROM (select * from t) q WHERE q.ID > :oicr_after ORDER BY q.ID FETCH FIRST :oicr_limit ROWS ONLY",
      values: { oicr_after: 42, oicr_limit: 100 },
    });
    expect(() => readConfig({ table: "t" })).toThrow(/key column/);
    expect(() => readConfig({ table: "t; drop table x", key: "id" })).toThrow(/not a valid table/);
    expect(() => readConfig({ sql: "select 1", key: "t.id" })).toThrow(/without a table prefix/);
    expect(keyOf({ ID: 7 }, "id")).toBe(7);
  });

  it("builds multi-row inserts and upserts", () => {
    const cfg = writeConfig({ table: "customers", key: "id" }, true);
    const rows = [
      { id: 1, name: "a" },
      { id: 2, name: "b", extra: "ignored" },
    ];
    const cols = columnsFor(cfg, rows);
    expect(multiRowWrite("postgres", cfg, cols, rows, true)).toEqual({
      text: "INSERT INTO customers (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
      values: [1, "a", 2, "b"],
    });
    expect(multiRowWrite("mysql", cfg, cols, rows.slice(0, 1), true).text).toBe(
      "INSERT INTO customers (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)",
    );
    expect(oracleWrite(cfg, cols, true)).toBe(
      "MERGE INTO customers d USING (SELECT :1 AS id, :2 AS name FROM dual) s ON (d.id = s.id) WHEN MATCHED THEN UPDATE SET d.name = s.name WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)",
    );
    expect(() => writeConfig({ table: "t" }, true)).toThrow(/key/);
    expect(() => columnsFor(writeConfig({ table: "t", key: "code" }, true), rows)).toThrow(/no "code" field/);
  });

  it("explains driver errors and says which are worth retrying", () => {
    const props = { host: "db.example.com", dialect: "postgres" as const };
    expect(dbError(Object.assign(new Error("password authentication failed"), { code: "28P01" }), props).code).toBe(
      "auth",
    );
    expect(dbError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), props)).toMatchObject({
      code: "connection",
      retryable: true,
    });
    expect(dbError(Object.assign(new Error("deadlock detected"), { code: "40P01" }), props)).toMatchObject({
      code: "sql_error",
      retryable: true,
    });
    expect(
      dbError(Object.assign(new Error("ORA-00001: unique constraint violated"), { errorNum: 1 }), props),
    ).toMatchObject({
      code: "sql_error",
      retryable: false,
      details: { ora: 1 },
    });
  });

  it("refuses private hosts unless allowed", async () => {
    const before = process.env.ALLOW_PRIVATE_NETWORK;
    delete process.env.ALLOW_PRIVATE_NETWORK;
    const r = await database.test({
      properties: { dialect: "postgres", host: "127.0.0.1", database: "x" },
      authType: "basic",
      secret: { username: "u", password: "p" },
    });
    process.env.ALLOW_PRIVATE_NETWORK = before;
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain("private or local address");
  });
});

// Live tests: ADAPTER_TEST_POSTGRES=postgres://user:pw@host:port/db, ADAPTER_TEST_MYSQL=mysql://...,
// ADAPTER_TEST_ORACLE=oracle://user:pw@host:port/SERVICE
const LIVE = (["postgres", "mysql", "oracle"] as const)
  .map((dialect) => ({ dialect, url: process.env[`ADAPTER_TEST_${dialect.toUpperCase()}`] }))
  .filter((x): x is { dialect: "postgres" | "mysql" | "oracle"; url: string } => !!x.url);

const DDL = {
  postgres: (t: string) => [
    `DROP TABLE IF EXISTS ${t}`,
    `CREATE TABLE ${t} (id INTEGER PRIMARY KEY, name VARCHAR(20) NOT NULL, amount NUMERIC(10,2), created_at TIMESTAMP)`,
  ],
  mysql: (t: string) => [
    `DROP TABLE IF EXISTS ${t}`,
    `CREATE TABLE ${t} (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL, amount DECIMAL(10,2), created_at DATETIME)`,
  ],
  oracle: (t: string) => [
    `DROP TABLE IF EXISTS ${t}`,
    `CREATE TABLE ${t} (id NUMBER(10) PRIMARY KEY, name VARCHAR2(20) NOT NULL, amount NUMBER(10,2), created_at TIMESTAMP)`,
  ],
};

const lower = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));

describe.each(LIVE)("database adapter on $dialect (live)", ({ dialect, url }) => {
  const u = new URL(url);
  const conn: ConnectionConfig = {
    properties: {
      dialect,
      host: u.hostname,
      port: Number(u.port),
      database: decodeURIComponent(u.pathname.slice(1)),
      ssl: "disable",
      maxRows: 50,
    },
    authType: "basic",
    secret: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
  };
  const src = "oicr_test_src";
  const dst = "oicr_test_dst";
  const exec = (sql: string, params: Record<string, unknown> = {}) =>
    database.invoke(conn, { operation: "execute", config: {}, request: { sql, params } });

  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_NETWORK = "true";
    for (const t of [src, dst]) for (const s of DDL[dialect](t)) await exec(s);
  }, 120_000);
  afterAll(() => database.close?.());

  it("connects", async () => {
    const r = await database.test(conn);
    expect(r.ok, r.message).toBe(true);
  });

  it("loads in chunks, reads back by key, and resumes after a cursor", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => ({
      id: i + 1,
      name: `name ${i + 1}`,
      amount: (i + 1) / 4,
      created_at: "2026-01-05T10:00:00Z",
    }));
    let written = 0;
    for (let i = 0; i < rows.length; i += 500)
      written += (
        await database.batch!.write(conn, { operation: "insert", config: { table: src }, rows: rows.slice(i, i + 500) })
      ).written;
    expect(written).toBe(1234);

    const chunks: { rows: Record<string, unknown>[]; cursor: unknown }[] = [];
    for await (const c of database.batch!.read(conn, {
      operation: "read",
      config: { table: src, where: "amount >= :min", key: "id" },
      params: { min: 0 },
      after: null,
      chunkSize: 500,
    }))
      chunks.push(c);
    expect(chunks.map((c) => c.rows.length)).toEqual([500, 500, 234]);
    expect(Number(chunks[0]!.cursor)).toBe(500);
    const first = lower(chunks[0]!.rows[0]!);
    expect(first).toMatchObject({ id: 1, name: "name 1" });
    expect(Number(first.amount)).toBe(0.25);
    expect(String(first.created_at)).toMatch(/^2026-01-05T10:00:00/);

    const resumed: number[] = [];
    for await (const c of database.batch!.read(conn, {
      operation: "read",
      config: { sql: `select id, name from ${src}`, key: "id" },
      params: {},
      after: chunks[1]!.cursor,
      chunkSize: 500,
    }))
      resumed.push(...c.rows.map((r) => Number(lower(r).id)));
    expect(resumed.length).toBe(234);
    expect(resumed[0]).toBe(1001);
  }, 120_000);

  it("upserts idempotently and rejects only the bad rows", async () => {
    const rows = [
      { id: 1, name: "first" },
      { id: 2, name: "this name is far too long for the column" },
      { id: 3, name: "third" },
    ];
    const r1 = await database.batch!.write(conn, { operation: "upsert", config: { table: dst, key: "id" }, rows });
    expect(r1.written).toBe(2);
    expect(r1.rejects.map((x) => x.index)).toEqual([1]);
    const r2 = await database.batch!.write(conn, {
      operation: "upsert",
      config: { table: dst, key: ["id"] },
      rows: [
        { id: 1, name: "first again" },
        { id: 3, name: "third" },
      ],
    });
    expect(r2).toEqual({ written: 2, rejects: [] });
    const out = (await database.invoke(conn, {
      operation: "query",
      config: {},
      request: { sql: `select id, name from ${dst} where id >= :minId order by id`, params: { minId: 1 } },
    })) as { rows: Record<string, unknown>[] };
    expect(out.rows.map(lower).map((r) => [Number(r.id), r.name])).toEqual([
      [1, "first again"],
      [3, "third"],
    ]);
  });

  it("caps query steps and refuses unbound parameters", async () => {
    await expect(
      database.invoke(conn, { operation: "query", config: {}, request: { sql: `select id from ${src}` } }),
    ).rejects.toThrow(/at most 50/);
    await expect(
      database.invoke(conn, {
        operation: "query",
        config: {},
        request: { sql: `select id from ${src} where id = :id` },
      }),
    ).rejects.toThrow(/no parameter "id"/);
  });
});
