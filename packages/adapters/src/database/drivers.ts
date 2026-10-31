import type mysql from "mysql2/promise";
import type oracledb from "oracledb";
import type postgres from "postgres";
import { type Dialect, plainRow, type Statement } from "./sql.js";

// One small interface over the three drivers. Each driver keeps a pool per
// connection; the adapter caches drivers by their settings.

export interface DbSettings {
  dialect: Dialect;
  /** The address to connect to (already resolved and checked), and the name for TLS. */
  address: string;
  hostname: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: "disable" | "require" | "verify";
  poolSize: number;
  timeoutSeconds: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export type Run = (stmt: Statement) => Promise<QueryResult>;

export interface BatchErrors {
  /** Rows written. */
  written: number;
  errors: { offset: number; code: string; message: string }[];
}

export interface Driver {
  readonly dialect: Dialect;
  query: Run;
  /** Runs `fn` on one connection inside a transaction; rolls back if it throws. */
  transaction<T>(fn: (run: Run) => Promise<T>): Promise<T>;
  /** Oracle: one statement for many rows, with per-row errors instead of failing the batch. */
  executeMany?(sql: string, rows: unknown[][]): Promise<BatchErrors>;
  close(): Promise<void>;
}

const tls = (s: DbSettings) =>
  s.ssl === "disable"
    ? undefined
    : s.ssl === "verify"
      ? { rejectUnauthorized: true, servername: s.hostname }
      : { rejectUnauthorized: false, servername: s.hostname };

export async function createDriver(s: DbSettings): Promise<Driver> {
  if (s.dialect === "postgres") return postgresDriver(s);
  if (s.dialect === "mysql") return mysqlDriver(s);
  return oracleDriver(s);
}

async function postgresDriver(s: DbSettings): Promise<Driver> {
  const { default: pg } = await import("postgres");
  const sql: postgres.Sql = pg({
    host: s.address,
    port: s.port,
    database: s.database,
    username: s.user,
    password: s.password,
    ssl: tls(s) ?? false,
    max: s.poolSize,
    connect_timeout: s.timeoutSeconds,
    idle_timeout: 60,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: "oicr-database-adapter", statement_timeout: s.timeoutSeconds * 1000 },
  });
  const runOn =
    (q: postgres.Sql | postgres.TransactionSql): Run =>
    async (stmt) => {
      const res = await q.unsafe(stmt.text, stmt.values as postgres.ParameterOrJSON<never>[]);
      return { rows: res.map((r) => plainRow(r as Record<string, unknown>)), rowCount: res.count ?? res.length };
    };
  return {
    dialect: "postgres",
    query: runOn(sql),
    transaction: (fn) => sql.begin((tx) => fn(runOn(tx))) as Promise<never>,
    close: () => sql.end({ timeout: 5 }),
  };
}

async function mysqlDriver(s: DbSettings): Promise<Driver> {
  const { default: my } = await import("mysql2/promise");
  const pool: mysql.Pool = my.createPool({
    host: s.address,
    port: s.port,
    database: s.database,
    user: s.user,
    password: s.password,
    ssl: tls(s),
    connectionLimit: s.poolSize,
    connectTimeout: s.timeoutSeconds * 1000,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  });
  const runOn =
    (c: mysql.Pool | mysql.PoolConnection): Run =>
    async (stmt) => {
      // query (client-side binding) rather than execute: prepared LIMIT ? is unreliable across versions.
      const [res] = await c.query({
        sql: stmt.text,
        values: stmt.values as unknown[],
        timeout: s.timeoutSeconds * 1000,
      });
      if (Array.isArray(res)) {
        const rows = res as Record<string, unknown>[];
        return { rows: rows.map(plainRow), rowCount: rows.length };
      }
      return { rows: [], rowCount: (res as mysql.ResultSetHeader).affectedRows };
    };
  return {
    dialect: "mysql",
    query: runOn(pool),
    async transaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(runOn(conn));
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
}

async function oracleDriver(s: DbSettings): Promise<Driver> {
  const { default: ora } = await import("oracledb");
  const connectString =
    s.ssl === "disable"
      ? `${s.address}:${s.port}/${s.database}`
      : `tcps://${s.hostname}:${s.port}/${s.database}?ssl_server_dn_match=${s.ssl === "verify" ? "true" : "false"}`;
  const pool = await ora.createPool({
    user: s.user,
    password: s.password,
    connectString,
    poolMin: 0,
    poolMax: s.poolSize,
    poolIncrement: 1,
    connectTimeout: s.timeoutSeconds,
    // ISO text in and out, whatever the database's NLS defaults are.
    sessionCallback: (conn: oracledb.Connection, _tag: string, done: (e?: Error) => void) => {
      conn
        .execute(
          `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.FF' NLS_NUMERIC_CHARACTERS = '.,' TIME_ZONE = '+00:00'`,
        )
        .then(() => done(), done);
    },
  });
  const options = (autoCommit: boolean): oracledb.ExecuteOptions => ({
    outFormat: ora.OUT_FORMAT_OBJECT,
    autoCommit,
    fetchInfo: {},
    fetchTypeHandler: (meta) => (meta.dbType === ora.DB_TYPE_CLOB ? { type: ora.STRING } : undefined),
  });
  const runOn =
    (conn: oracledb.Connection, autoCommit: boolean): Run =>
    async (stmt) => {
      conn.callTimeout = s.timeoutSeconds * 1000;
      const res = await conn.execute(stmt.text, stmt.values as oracledb.BindParameters, options(autoCommit));
      const rows = (res.rows ?? []) as Record<string, unknown>[];
      return { rows: rows.map(plainRow), rowCount: res.rowsAffected ?? rows.length };
    };
  const withConn = async <T>(fn: (c: oracledb.Connection) => Promise<T>): Promise<T> => {
    const conn = await pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  };
  return {
    dialect: "oracle",
    query: (stmt) => withConn((c) => runOn(c, true)(stmt)),
    transaction: (fn) =>
      withConn(async (c) => {
        try {
          const out = await fn(runOn(c, false));
          await c.commit();
          return out;
        } catch (e) {
          await c.rollback().catch(() => {});
          throw e;
        }
      }),
    executeMany: (sql, rows) =>
      withConn(async (c) => {
        c.callTimeout = s.timeoutSeconds * 1000;
        const res = await c.executeMany(sql, rows as oracledb.BindParameters[], {
          autoCommit: false,
          batchErrors: true,
          dmlRowCounts: true,
        });
        // Rows without errors are kept: commit them, report the rest.
        await c.commit();
        const errors = (res.batchErrors ?? []).map((e) => ({
          offset: (e as { offset: number }).offset,
          code: `ORA-${String(e.errorNum ?? "").padStart(5, "0")}`,
          message: e.message,
        }));
        return { written: rows.length - errors.length, errors };
      }),
    close: () => pool.close(5),
  };
}
