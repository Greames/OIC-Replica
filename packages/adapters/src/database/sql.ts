import { AdapterError } from "../types.js";

// SQL for the database adapter, per dialect. Values are always bound, never
// spliced in. Identifiers (tables, columns, keys) come from the integration's
// configuration and are checked against a strict pattern instead of quoted,
// so they keep each database's usual case rules (Oracle's EBS tables are
// upper case; Postgres folds to lower case).

export const DIALECTS = ["postgres", "mysql", "oracle"] as const;
export type Dialect = (typeof DIALECTS)[number];

export interface Statement {
  text: string;
  /** Postgres and MySQL: positional values. Oracle: named binds. */
  values: unknown[] | Record<string, unknown>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$#]{0,127}(\.[A-Za-z_][A-Za-z0-9_$#]{0,127}){0,2}$/;

/** A table or column name, optionally schema-qualified; anything else is refused. */
export function ident(name: unknown, what = "name"): string {
  if (typeof name !== "string" || !IDENT.test(name))
    throw new AdapterError(
      "invalid_identifier",
      `${JSON.stringify(name)} is not a valid ${what}. Use letters, digits, _, $ and #, optionally schema.table.`,
    );
  return name;
}

/**
 * Turns `:name` parameters into the dialect's placeholders. Strings,
 * quoted identifiers, comments, Postgres casts (::) and := are left alone.
 */
export function bindNamed(sql: string, params: Record<string, unknown>, dialect: Dialect): Statement {
  let text = "";
  const positional: unknown[] = [];
  const named: Record<string, unknown> = {};
  const pgIndex = new Map<string, number>();
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      const end = closeQuote(sql, i);
      text += sql.slice(i, end + 1);
      i = end;
    } else if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length - 1 : end;
      text += sql.slice(i, stop + 1);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length - 1 : end + 1;
      text += sql.slice(i, stop + 1);
      i = stop;
    } else if (c === ":" && (next === ":" || next === "=")) {
      text += c + next;
      i++;
    } else if (c === ":" && next && /[A-Za-z_]/.test(next) && sql[i - 1] !== ":") {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))!;
      const name = m[0];
      if (!Object.hasOwn(params, name))
        throw new AdapterError("missing_param", `The SQL uses :${name}, but no parameter "${name}" was given.`);
      const value = toBindValue(params[name]);
      if (dialect === "postgres") {
        let n = pgIndex.get(name);
        if (n === undefined) {
          positional.push(value);
          n = positional.length;
          pgIndex.set(name, n);
        }
        text += `$${n}`;
      } else if (dialect === "mysql") {
        positional.push(value);
        text += "?";
      } else {
        named[name] = value;
        text += `:${name}`;
      }
      i += name.length;
    } else {
      text += c;
    }
  }
  return { text, values: dialect === "oracle" ? named : positional };
}

function closeQuote(sql: string, start: number): number {
  const q = sql[start];
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) i++;
      else return i;
    } else if (sql[i] === "\\" && q === "`") i++;
  }
  return sql.length - 1;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** A JSON value as a driver bind value: objects as JSON text, ISO timestamps as dates. */
export function toBindValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "string" && ISO_DATETIME.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;
  }
  if (v !== null && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

/** A driver row as plain JSON: dates as ISO text, binaries as base64, big integers as text. */
export function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = plainValue(v);
  return out;
}

function plainValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (Array.isArray(v)) return v.map(plainValue);
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = plainValue(x);
    return o;
  }
  return v;
}

// ── batch reads ───────────────────────────────────────────────────────────

export interface ReadConfig {
  /** A query (with :params); or `table` (+ `columns`, `where`). */
  sql?: string;
  table?: string;
  columns?: string[];
  where?: string;
  /** A unique, non-null, sortable column: reads go in key order and resume after the last key. */
  key: string;
}

export function readConfig(config: Record<string, unknown>): ReadConfig {
  const key = ident(config.key, "key column");
  if (key.includes("."))
    throw new AdapterError(
      "invalid_config",
      `"key" is a column of the query's result, without a table prefix: not "${key}".`,
    );
  if (typeof config.sql === "string" && config.sql.trim()) {
    return { sql: config.sql.trim().replace(/;\s*$/, ""), key };
  }
  if (config.table === undefined)
    throw new AdapterError("invalid_config", 'Give the source "sql" (a query) or "table", plus its "key" column.');
  return {
    table: ident(config.table, "table"),
    columns: Array.isArray(config.columns) ? config.columns.map((c) => ident(c, "column")) : undefined,
    where: typeof config.where === "string" && config.where.trim() ? config.where.trim() : undefined,
    key,
  };
}

/**
 * One page of a keyset read: rows after `after` in key order, at most `limit`.
 * The base query is wrapped, so any query works as long as it returns the key.
 */
export function keysetPage(
  dialect: Dialect,
  cfg: ReadConfig,
  params: Record<string, unknown>,
  after: unknown,
  limit: number,
): Statement {
  const base = cfg.sql
    ? cfg.sql
    : `SELECT ${cfg.columns?.length ? cfg.columns.join(", ") : "*"} FROM ${cfg.table}${cfg.where ? ` WHERE ${cfg.where}` : ""}`;
  if (Object.hasOwn(params, "oicr_after") || Object.hasOwn(params, "oicr_limit"))
    throw new AdapterError("invalid_param", "Parameter names oicr_after and oicr_limit are reserved.");
  const all = { ...params, oicr_after: after, oicr_limit: limit };
  const keyed = after === null || after === undefined ? "" : ` WHERE q.${cfg.key} > :oicr_after`;
  const tail = dialect === "oracle" ? " FETCH FIRST :oicr_limit ROWS ONLY" : " LIMIT :oicr_limit";
  return bindNamed(`SELECT q.* FROM (${base}) q${keyed} ORDER BY q.${cfg.key}${tail}`, all, dialect);
}

/** The key of a row, whatever case the driver used for the column name. */
export function keyOf(row: Record<string, unknown>, key: string): unknown {
  const column = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  if (Object.hasOwn(row, column)) return row[column];
  const lower = column.toLowerCase();
  const found = Object.keys(row).find((k) => k.toLowerCase() === lower);
  if (found === undefined)
    throw new AdapterError("key_missing", `The rows have no "${key}" column, so the read cannot continue after them.`);
  return row[found];
}

// ── batch writes ──────────────────────────────────────────────────────────

export interface WriteConfig {
  table: string;
  /** Upsert: the columns that identify a row (a unique key in the table). */
  key: string[];
  /** Columns to write; default: the fields of the first record. */
  columns?: string[];
}

export function writeConfig(config: Record<string, unknown>, upsert: boolean): WriteConfig {
  const keyList = config.key === undefined ? [] : Array.isArray(config.key) ? config.key : [config.key];
  const key = keyList.map((k) => ident(k, "key column"));
  if (upsert && key.length === 0)
    throw new AdapterError("invalid_config", 'Upserts need "key": the column(s) of a unique key in the table.');
  return {
    table: ident(config.table, "table"),
    key,
    columns: Array.isArray(config.columns) ? config.columns.map((c) => ident(c, "column")) : undefined,
  };
}

/** The columns a chunk writes: configured, or the first record's fields (checked). */
export function columnsFor(cfg: WriteConfig, rows: Record<string, unknown>[]): string[] {
  const cols = cfg.columns ?? Object.keys(rows[0] ?? {}).map((c) => ident(c, "column"));
  if (cols.length === 0) throw new AdapterError("invalid_rows", "The records have no fields to write.");
  for (const k of cfg.key)
    if (!cols.some((c) => c.toLowerCase() === k.toLowerCase()))
      throw new AdapterError("invalid_rows", `The records have no "${k}" field, which the key needs.`);
  return cols;
}

/** Postgres allows 65535 bind values per statement; stay well under for every dialect. */
export const MAX_BINDS = 30_000;

/** A multi-row INSERT (or upsert) for Postgres or MySQL. */
export function multiRowWrite(
  dialect: "postgres" | "mysql",
  cfg: WriteConfig,
  cols: string[],
  rows: Record<string, unknown>[],
  upsert: boolean,
): Statement {
  const values: unknown[] = [];
  const tuples = rows.map((r) => {
    const marks = cols.map((c) => {
      values.push(toBindValue(r[c]));
      return dialect === "postgres" ? `$${values.length}` : "?";
    });
    return `(${marks.join(", ")})`;
  });
  let text = `INSERT INTO ${cfg.table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}`;
  if (upsert) {
    const isKey = (c: string) => cfg.key.some((k) => k.toLowerCase() === c.toLowerCase());
    const rest = cols.filter((c) => !isKey(c));
    if (dialect === "postgres") {
      text += ` ON CONFLICT (${cfg.key.join(", ")}) ${
        rest.length ? `DO UPDATE SET ${rest.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}` : "DO NOTHING"
      }`;
    } else {
      const set = rest.length ? rest : [cols[0]!];
      text += ` ON DUPLICATE KEY UPDATE ${set.map((c) => `${c} = VALUES(${c})`).join(", ")}`;
    }
  }
  return { text, values };
}

/** Oracle: one statement for executeMany (binds :1..:n per row). */
export function oracleWrite(cfg: WriteConfig, cols: string[], upsert: boolean): string {
  const binds = cols.map((_, i) => `:${i + 1}`);
  if (!upsert) return `INSERT INTO ${cfg.table} (${cols.join(", ")}) VALUES (${binds.join(", ")})`;
  const isKey = (c: string) => cfg.key.some((k) => k.toLowerCase() === c.toLowerCase());
  const rest = cols.filter((c) => !isKey(c));
  return [
    `MERGE INTO ${cfg.table} d USING (SELECT ${cols.map((c, i) => `${binds[i]} AS ${c}`).join(", ")} FROM dual) s`,
    `ON (${cfg.key.map((k) => `d.${k} = s.${k}`).join(" AND ")})`,
    rest.length ? `WHEN MATCHED THEN UPDATE SET ${rest.map((c) => `d.${c} = s.${c}`).join(", ")}` : "",
    `WHEN NOT MATCHED THEN INSERT (${cols.join(", ")}) VALUES (${cols.map((c) => `s.${c}`).join(", ")})`,
  ]
    .filter(Boolean)
    .join(" ");
}
