import jsonata from "jsonata";
import type { AttributeType, Dialect } from "./catalog.js";
import type { CompiledField, CompiledObject, SemanticPlan } from "./compile.js";

// The semantic functions as JSONata bindings, built from a compiled plan.
// Reading normalises values to the catalog's standard form (numbers, JSON
// booleans, ISO dates); writing produces the system's dialect.

export class SemanticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticError";
  }
}

type Fn = (...args: never[]) => unknown;

export interface SemanticFunctions extends Record<string, Fn> {
  toSemantic: (value: unknown, system: string, object: string) => Promise<unknown>;
  fromSemantic: (value: unknown, system: string, object: string) => Promise<unknown>;
  translate: (
    value: unknown,
    fromSystem: string,
    fromObject: string,
    toSystem: string,
    toObject: string,
  ) => Promise<unknown>;
}

// Compiled transforms, shared by every plan in the process.
const transforms = new Map<string, jsonata.Expression>();
function transform(source: string): jsonata.Expression {
  let e = transforms.get(source);
  if (!e) {
    if (transforms.size >= 1000) transforms.delete(transforms.keys().next().value!);
    e = jsonata(source);
    transforms.set(source, e);
  }
  return e;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function getPath(record: Record<string, unknown>, path: string[]): unknown {
  let v: unknown = record;
  for (const p of path) {
    if (!isRecord(v)) return undefined;
    v = v[p];
  }
  return v;
}

function setPath(record: Record<string, unknown>, path: string[], value: unknown): void {
  let node = record;
  for (const p of path.slice(0, -1)) {
    if (!isRecord(node[p])) node[p] = {};
    node = node[p] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

const ODATA_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;
const TRUE = new Set(["y", "yes", "true", "1", "x"]);
const FALSE = new Set(["n", "no", "false", "0", ""]);

/** A technical value in the catalog's form; values that do not fit are passed on unchanged. */
export function toStandard(v: unknown, type: AttributeType): unknown {
  if (v === null || v === undefined) return v;
  switch (type) {
    case "number":
    case "integer":
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      return v;
    case "boolean":
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (TRUE.has(s)) return true;
        if (FALSE.has(s)) return false;
      }
      if (typeof v === "number") return v !== 0;
      return v;
    case "date":
    case "datetime": {
      if (typeof v !== "string") return v;
      const odata = ODATA_DATE.exec(v);
      if (odata) {
        const iso = new Date(Number(odata[1])).toISOString();
        return type === "date" ? iso.slice(0, 10) : iso;
      }
      // "2026-10-27 13:05:00" (database text) → ISO
      const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(.*))?$/.exec(v);
      if (!m) return v;
      if (type === "date") return m[1];
      return m[2] ? `${m[1]}T${m[2]}${m[3] ?? ""}` : m[1];
    }
    case "string":
    case "currency":
    case "email":
      return typeof v === "number" || typeof v === "boolean" ? String(v) : v;
  }
}

/** A catalog value in a system's dialect. */
export function toDialect(v: unknown, type: AttributeType, dialect: Dialect): unknown {
  if (v === null || v === undefined) return v;
  if (type === "boolean" && typeof v === "boolean" && dialect.booleans === "YN") return v ? "Y" : "N";
  if ((type === "date" || type === "datetime") && typeof v === "string" && dialect.dates === "odata-v2") {
    const ms = Date.parse(type === "date" && v.length === 10 ? `${v}T00:00:00Z` : v);
    return Number.isNaN(ms) ? v : `/Date(${ms})/`;
  }
  return v;
}

async function applyTransform(
  source: string,
  context: unknown,
  value: unknown,
  o: CompiledObject,
  f: CompiledField,
): Promise<unknown> {
  try {
    const out = await transform(source).evaluate(context, { value });
    return out === undefined ? undefined : JSON.parse(JSON.stringify(out));
  } catch (e) {
    throw new SemanticError(
      `The binding of ${o.object}.${f.path.join(".")} to ${o.entity}.${f.attribute} failed: ${(e as Error).message}`,
    );
  }
}

async function readOne(o: CompiledObject, record: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(record))
    throw new SemanticError(`$toSemantic expects ${o.object} records (objects), got ${typeName(record)}.`);
  const out: Record<string, unknown> = {};
  for (const f of o.fields) {
    let v = getPath(record, f.path);
    if (v === undefined) continue;
    if (f.read) v = await applyTransform(f.read, record, v, o, f);
    v = toStandard(v, f.type);
    if (v !== undefined) out[f.attribute] = v;
  }
  return out;
}

async function writeOne(o: CompiledObject, entity: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(entity))
    throw new SemanticError(`$fromSemantic expects ${o.entity} records (objects), got ${typeName(entity)}.`);
  const out: Record<string, unknown> = {};
  for (const f of o.fields) {
    if (f.readOnly) continue;
    let v = entity[f.attribute];
    if (v === undefined) continue;
    v = f.write ? await applyTransform(f.write, entity, v, o, f) : toDialect(v, f.type, o.dialect);
    if (v !== undefined) setPath(out, f.path, v);
  }
  return out;
}

const typeName = (v: unknown) => (Array.isArray(v) ? "a list" : v === null ? "null" : typeof v);

/** One record or a list of records; nothing stays nothing. */
async function each(value: unknown, fn: (v: unknown) => Promise<unknown>): Promise<unknown> {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return Promise.all(value.map(fn));
  return fn(value);
}

/**
 * $toSemantic, $fromSemantic and $translate for a plan. Without a plan (a run
 * from before semantic plans existed) every call explains what to do.
 */
export function semanticFunctions(plan: SemanticPlan | null | undefined): SemanticFunctions {
  const find = (system: unknown, object: unknown): CompiledObject => {
    const o = plan?.objects[`${String(system)}/${String(object)}`];
    if (!o)
      throw new SemanticError(
        `"${String(object)}" of system "${String(system)}" is not in this integration's execution plan. Activate the integration again to compile its semantic bindings.`,
      );
    return o;
  };
  return {
    toSemantic: async (value, system, object) => {
      const o = find(system, object);
      return each(value, (r) => readOne(o, r));
    },
    fromSemantic: async (value, system, object) => {
      const o = find(system, object);
      return each(value, (e) => writeOne(o, e));
    },
    translate: async (value, fromSystem, fromObject, toSystem, toObject) => {
      const from = find(fromSystem, fromObject);
      const to = find(toSystem, toObject);
      if (from.entity !== to.entity)
        throw new SemanticError(
          `$translate needs two objects of the same entity, not ${from.entity} and ${to.entity}.`,
        );
      return each(value, async (r) => writeOne(to, await readOne(from, r)));
    },
  };
}
