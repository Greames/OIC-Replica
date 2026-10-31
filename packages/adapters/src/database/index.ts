import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { recordError, SpanKind, withSpan } from "@oicr/platform";
import { z } from "zod";
import { isBlockedAddress, privateNetworkAllowed } from "../network.js";
import { type Adapter, AdapterError, type BatchWriteResult, type ConnectionConfig, type TestResult } from "../types.js";
import { createDriver, type DbSettings, type Driver } from "./drivers.js";
import {
  bindNamed,
  columnsFor,
  DIALECTS,
  type Dialect,
  keyOf,
  keysetPage,
  MAX_BINDS,
  multiRowWrite,
  oracleWrite,
  readConfig,
  toBindValue,
  writeConfig,
} from "./sql.js";

export * from "./sql.js";

const DEFAULT_PORT: Record<Dialect, number> = { postgres: 5432, mysql: 3306, oracle: 1521 };
const LABEL: Record<Dialect, string> = { postgres: "PostgreSQL", mysql: "MySQL", oracle: "Oracle" };

export const DatabaseProperties = z.object({
  dialect: z.enum(DIALECTS, { message: "Choose PostgreSQL, MySQL or Oracle." }),
  host: z.string().trim().min(1, "Enter the database host."),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1, "Enter the database name (the service name for Oracle)."),
  ssl: z.enum(["disable", "require", "verify"]).default("require"),
  poolSize: z.coerce.number().int().min(1).max(20).default(4),
  timeoutSeconds: z.coerce.number().int().min(1).max(600).default(30),
  maxRows: z.coerce.number().int().min(1).max(10_000).default(1000),
});
export type DatabaseProperties = z.infer<typeof DatabaseProperties>;

const Credentials = z.object({ username: z.string().min(1), password: z.string().min(1) });

const QueryRequest = z.object({
  sql: z.string().min(1, "Give the SQL to run."),
  params: z.record(z.string(), z.unknown()).default({}),
});

// ── pools ─────────────────────────────────────────────────────────────────

interface Pooled {
  driver: Promise<Driver>;
  lastUsed: number;
}
const pools = new Map<string, Pooled>();
const IDLE_MS = 5 * 60_000;
let sweeper: NodeJS.Timeout | undefined;

function sweep(): void {
  const now = Date.now();
  for (const [k, p] of pools)
    if (now - p.lastUsed > IDLE_MS) {
      pools.delete(k);
      void p.driver.then((d) => d.close()).catch(() => {});
    }
  if (pools.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

/** Resolves the host and refuses private addresses unless allowed (the same rule as HTTP). */
async function resolveHost(host: string): Promise<string> {
  const literal = host.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(literal)) addresses = [literal];
  else {
    try {
      addresses = (await lookup(literal, { all: true })).map((a) => a.address);
    } catch {
      throw new AdapterError("dns", `${host} could not be found. Check the host name.`);
    }
  }
  if (!privateNetworkAllowed()) {
    const bad = addresses.find(isBlockedAddress);
    if (bad || literal === "localhost")
      throw new AdapterError(
        "private_network",
        `${host} is a private or local address. Connections can only reach public endpoints; on-premises databases go through the connectivity agent.`,
      );
  }
  return addresses[0]!;
}

async function driverFor(conn: ConnectionConfig): Promise<{ driver: Driver; props: DatabaseProperties }> {
  const props = parse(DatabaseProperties, conn.properties, "invalid_settings");
  const creds = parse(Credentials, conn.secret ?? {}, "missing_credentials");
  const key = createHash("sha256")
    .update(JSON.stringify([props, creds]))
    .digest("hex");
  let pooled = pools.get(key);
  if (!pooled) {
    const settings = async (): Promise<DbSettings> => ({
      dialect: props.dialect,
      address: await resolveHost(props.host),
      hostname: props.host,
      port: props.port ?? DEFAULT_PORT[props.dialect],
      database: props.database,
      user: creds.username,
      password: creds.password,
      ssl: props.ssl,
      poolSize: props.poolSize,
      timeoutSeconds: props.timeoutSeconds,
    });
    pooled = { driver: settings().then(createDriver), lastUsed: Date.now() };
    pools.set(key, pooled);
    // A failed start is not cached.
    pooled.driver.catch(() => pools.delete(key));
    sweeper ??= setInterval(sweep, 60_000);
    sweeper.unref();
  }
  pooled.lastUsed = Date.now();
  try {
    return { driver: await pooled.driver, props };
  } catch (e) {
    throw dbError(e, props);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AdapterError(code, r.error.issues[0]?.message ?? "Check the connection settings.");
  return r.data;
}

// ── errors ────────────────────────────────────────────────────────────────

const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
  "40001",
  "40P01",
  "57P01",
  "53300",
]);
const RETRYABLE_ORA = new Set([60, 3113, 3114, 3135, 12170, 12514, 12541, 12543, 25408]);

/** A driver error as an AdapterError: what went wrong, and whether retrying can help. */
export function dbError(e: unknown, props: Pick<DatabaseProperties, "host" | "dialect">): AdapterError {
  if (e instanceof AdapterError) return e;
  const err = e as { code?: string; errno?: number; errorNum?: number; message?: string; sqlState?: string };
  const message = err.message ?? String(e);
  const code = err.code ?? "";
  const ora = err.errorNum ?? Number(/ORA-(\d{5})/.exec(message)?.[1] ?? Number.NaN);
  if (code === "28P01" || code === "28000" || code === "ER_ACCESS_DENIED_ERROR" || ora === 1017)
    return new AdapterError("auth", `${props.host} rejected the user name or password.`);
  if (code === "ENOTFOUND") return new AdapterError("dns", `${props.host} could not be found. Check the host name.`);
  const retryable = RETRYABLE_CODES.has(code) || RETRYABLE_ORA.has(ora) || /NJS-50[0-9]/.test(code);
  if (retryable && /^(E[A-Z]+|CONNECT|CONNECTION|PROTOCOL|NJS)/.test(code))
    return new AdapterError(
      "connection",
      `Could not reach ${LABEL[props.dialect]} at ${props.host}: ${message}`,
      undefined,
      true,
    );
  return new AdapterError(
    "sql_error",
    message.length > 500 ? `${message.slice(0, 500)}…` : message,
    {
      sqlState: err.sqlState ?? (/^[0-9A-Z]{5}$/.test(code) ? code : undefined),
      driverCode: code || undefined,
      ora: Number.isNaN(ora) ? undefined : ora,
    },
    retryable,
  );
}

const traced = <T>(props: DatabaseProperties, operation: string, fn: () => Promise<T>) =>
  withSpan(
    `db ${operation}`,
    {
      "db.system": props.dialect === "postgres" ? "postgresql" : props.dialect,
      "db.operation.name": operation,
      "server.address": props.host,
      "db.namespace": props.database,
    },
    async (span) => {
      try {
        return await fn();
      } catch (e) {
        const err = dbError(e, props);
        recordError(span, err);
        throw err;
      }
    },
    { kind: SpanKind.CLIENT },
  );

// ── writes ────────────────────────────────────────────────────────────────

async function writeRows(
  driver: Driver,
  props: DatabaseProperties,
  operation: string,
  config: Record<string, unknown>,
  rows: Record<string, unknown>[],
): Promise<BatchWriteResult> {
  if (rows.length === 0) return { written: 0, rejects: [] };
  const upsert = operation === "upsert";
  const cfg = writeConfig(config, upsert);
  const cols = columnsFor(cfg, rows);
  if (driver.dialect === "oracle") {
    const sql = oracleWrite(cfg, cols, upsert);
    const binds = rows.map((r) => cols.map((c) => toBindValue(r[c])));
    try {
      const res = await traced(props, upsert ? "MERGE" : "INSERT", () => driver.executeMany!(sql, binds));
      return {
        written: res.written,
        rejects: res.errors.map((e) => ({ index: e.offset, code: e.code, message: e.message })),
      };
    } catch (e) {
      const err = dbError(e, props);
      if (err.retryable) throw err;
      return rowByRow(driver, props, rows, (r) => ({ text: sql, values: cols.map((c) => toBindValue(r[c])) }));
    }
  }
  const dialect = driver.dialect;
  const perStatement = Math.max(1, Math.floor(MAX_BINDS / cols.length));
  try {
    await traced(props, upsert ? "UPSERT" : "INSERT", () =>
      driver.transaction(async (run) => {
        for (let i = 0; i < rows.length; i += perStatement)
          await run(multiRowWrite(dialect, cfg, cols, rows.slice(i, i + perStatement), upsert));
      }),
    );
    return { written: rows.length, rejects: [] };
  } catch (e) {
    const err = dbError(e, props);
    if (err.retryable) throw err;
    // The chunk was rolled back: write row by row to keep the good rows and name the bad ones.
    return rowByRow(driver, props, rows, (r) => multiRowWrite(dialect, cfg, cols, [r], upsert));
  }
}

async function rowByRow(
  driver: Driver,
  props: DatabaseProperties,
  rows: Record<string, unknown>[],
  statement: (row: Record<string, unknown>) => { text: string; values: unknown[] | Record<string, unknown> },
): Promise<BatchWriteResult> {
  const rejects: BatchWriteResult["rejects"] = [];
  for (const [index, row] of rows.entries()) {
    try {
      await driver.query(statement(row));
    } catch (e) {
      const err = dbError(e, props);
      if (err.retryable) throw err;
      rejects.push({ index, code: err.code, message: err.message });
    }
  }
  return { written: rows.length - rejects.length, rejects };
}

const asRows = (request: unknown): Record<string, unknown>[] => {
  const rows =
    request && typeof request === "object" && !Array.isArray(request) && "rows" in request
      ? (request as { rows: unknown }).rows
      : request;
  const list = Array.isArray(rows) ? rows : rows === undefined || rows === null ? [] : [rows];
  if (!list.every((r) => r && typeof r === "object" && !Array.isArray(r)))
    throw new AdapterError("invalid_request", 'Give the records to write as objects: { "rows": [ {...}, ... ] }.');
  return list as Record<string, unknown>[];
};

// ── the adapter ───────────────────────────────────────────────────────────

const READ_OPS = ["read"];
const WRITE_OPS = ["insert", "upsert"];

export const database: Adapter<DatabaseProperties> = {
  id: "database",
  name: "Database",
  description: "Query and load PostgreSQL, MySQL and Oracle databases (including Oracle E-Business Suite).",
  roles: ["invoke"],
  authTypes: ["basic"],
  properties: DatabaseProperties,
  operationHelp:
    'Operations: "query" (request { "sql": "select ... where id = :id", "params": { "id": 1 } } → { "rows", "rowCount" }; at most maxRows rows), "execute" (same request → { "rowCount" }), "insert" and "upsert" (config { "table": "SCHEMA.TABLE", "key": ["ID"] }, request { "rows": [...] } → { "written" }). Parameters are :name and always bound. In a pipeline step: source operation "read" with config { "sql": "select ...", "key": "ID" } or { "table": "...", "where": "...", "key": "ID" } (key: a unique, sortable column; reads resume after the last key), and target operation "insert" or "upsert".',
  fields: [
    {
      key: "dialect",
      label: "Database",
      type: "select",
      required: true,
      options: [
        { value: "postgres", label: "PostgreSQL" },
        { value: "mysql", label: "MySQL" },
        { value: "oracle", label: "Oracle (incl. E-Business Suite)" },
      ],
    },
    { key: "host", label: "Host", type: "text", required: true, placeholder: "db.example.com" },
    { key: "port", label: "Port", type: "number", placeholder: "5432 / 3306 / 1521" },
    { key: "database", label: "Database (service name for Oracle)", type: "text", required: true, placeholder: "erp" },
    {
      key: "ssl",
      label: "TLS",
      type: "select",
      options: [
        { value: "require", label: "Encrypted (default)" },
        { value: "verify", label: "Encrypted, verify the certificate" },
        { value: "disable", label: "Not encrypted" },
      ],
    },
    { key: "poolSize", label: "Connections per worker", type: "number", placeholder: "4" },
    { key: "timeoutSeconds", label: "Statement timeout (seconds)", type: "number", placeholder: "30" },
    { key: "maxRows", label: "Most rows a query step returns", type: "number", placeholder: "1000" },
    { key: "username", label: "User", type: "text", required: true, authTypes: ["basic"], secret: true },
    { key: "password", label: "Password", type: "password", required: true, authTypes: ["basic"], secret: true },
  ],

  async test(conn): Promise<TestResult> {
    try {
      const { driver, props } = await driverFor(conn);
      const sql =
        props.dialect === "oracle"
          ? "SELECT banner AS version FROM v$version WHERE ROWNUM = 1"
          : "SELECT version() AS version";
      const res = await traced(props, "SELECT", () =>
        driver.query({ text: sql, values: props.dialect === "oracle" ? {} : [] }),
      );
      const version = String(Object.values(res.rows[0] ?? {})[0] ?? "").split("\n")[0];
      return {
        ok: true,
        message: `Connected to ${LABEL[props.dialect]}${version ? `: ${version.slice(0, 120)}` : "."}`,
      };
    } catch (e) {
      const err = e instanceof AdapterError ? e : dbError(e, (conn.properties ?? {}) as DatabaseProperties);
      return { ok: false, message: err.message };
    }
  },

  async invoke(conn, { operation, config, request }) {
    const { driver, props } = await driverFor(conn);
    if (operation === "query" || operation === "execute") {
      const req = parse(QueryRequest, typeof request === "string" ? { sql: request } : request, "invalid_request");
      const stmt = bindNamed(req.sql, req.params, props.dialect);
      const res = await traced(props, operation === "query" ? "SELECT" : "EXECUTE", () => driver.query(stmt));
      if (operation === "execute") return { rowCount: res.rowCount };
      if (res.rows.length > props.maxRows)
        throw new AdapterError(
          "too_many_rows",
          `The query returned ${res.rows.length} rows; a query step returns at most ${props.maxRows}. Narrow it, or move many rows with a pipeline step.`,
        );
      return { rows: res.rows, rowCount: res.rows.length };
    }
    if (WRITE_OPS.includes(operation)) {
      const rows = asRows(request);
      const res = await writeRows(driver, props, operation, config, rows);
      if (res.rejects.length > 0)
        throw new AdapterError(
          "rows_rejected",
          `${res.rejects.length} of ${rows.length} row(s) were refused, e.g. row ${res.rejects[0]!.index + 1}: ${res.rejects[0]!.message}`,
          { written: res.written, rejects: res.rejects.slice(0, 20) },
        );
      return { written: res.written };
    }
    throw new AdapterError(
      "invalid_operation",
      `Database operations are query, execute, insert and upsert (and read in a pipeline). Got "${operation}".`,
    );
  },

  batch: {
    readOperations: READ_OPS,
    writeOperations: WRITE_OPS,
    checkConfig(kind, operation, config) {
      const ops = kind === "read" ? READ_OPS : WRITE_OPS;
      if (!ops.includes(operation))
        throw new AdapterError(
          "invalid_operation",
          `A database ${kind === "read" ? "source" : "target"} uses ${ops.join(" or ")}, not "${operation}".`,
        );
      if (kind === "read") readConfig(config);
      else writeConfig(config, operation === "upsert");
    },
    async *read(conn, { config, params, after, chunkSize, signal }) {
      const { driver, props } = await driverFor(conn);
      const cfg = readConfig(config);
      let cursor: unknown = after ?? null;
      for (;;) {
        if (signal?.aborted) throw new AdapterError("aborted", "The read was cancelled.");
        const page = keysetPage(props.dialect, cfg, params, cursor, chunkSize);
        const res = await traced(props, "SELECT", () => driver.query(page));
        if (res.rows.length === 0) return;
        cursor = keyOf(res.rows[res.rows.length - 1]!, cfg.key);
        yield { rows: res.rows, cursor };
        if (res.rows.length < chunkSize) return;
      }
    },
    async write(conn, { operation, config, rows }) {
      const { driver, props } = await driverFor(conn);
      return writeRows(driver, props, operation, config, rows);
    },
  },

  async close() {
    const all = [...pools.values()];
    pools.clear();
    await Promise.all(all.map((p) => p.driver.then((d) => d.close()).catch(() => {})));
  },
};
