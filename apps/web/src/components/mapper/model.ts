import type { MapField, Shape } from "@oicr/flow-schema";

// The mapper's editable target tree. It wraps MapField with ids, required
// flags from the target schema, and placeholder rows for schema fields that
// are not mapped yet (left out of the expression until they are).

export interface UIField {
  uid: string;
  key: string;
  expr?: string;
  each?: string;
  wrap?: boolean;
  fields?: UIField[];
  required?: boolean;
  /** The target schema's type, shown as a hint. */
  type?: string;
}

let counter = 0;
export const newUid = () => `f${++counter}`;

const objectFields = (shape?: Shape) => (shape?.type === "object" ? (shape.fields ?? []) : []);

/** Mapped fields merged with the target schema: required flags, types and placeholders. */
export function toUI(fields: MapField[], schema?: Shape): UIField[] {
  const known = objectFields(schema);
  const out: UIField[] = fields.map((f) => {
    const s = known.find((k) => k.name === f.key);
    const base = { uid: newUid(), key: f.key, required: s?.required, type: s?.shape.type };
    if (f.each !== undefined)
      return { ...base, each: f.each, wrap: f.wrap, fields: toUI(f.fields ?? [], s?.shape.items) };
    if (f.fields) return { ...base, fields: toUI(f.fields, s?.shape) };
    return { ...base, expr: f.expr ?? "" };
  });
  for (const k of known) {
    if (fields.some((f) => f.key === k.name)) continue;
    const base = { uid: newUid(), key: k.name, required: k.required, type: k.shape.type };
    if (k.shape.type === "object") out.push({ ...base, fields: toUI([], k.shape) });
    else if (k.shape.type === "array" && k.shape.items?.type === "object")
      out.push({ ...base, each: "", wrap: true, fields: toUI([], k.shape.items) });
    else out.push({ ...base, expr: "" });
  }
  return out;
}

export function isMapped(f: UIField): boolean {
  if (f.each !== undefined) return f.each.trim() !== "";
  if (f.fields) return f.fields.some(isMapped);
  return Boolean(f.expr?.trim());
}

/** Back to MapField, leaving out rows with nothing mapped. */
export function toMapping(fields: UIField[]): MapField[] {
  return fields.filter(isMapped).map((f) => {
    if (f.each !== undefined)
      return { key: f.key, each: f.each, ...(f.wrap ? { wrap: true } : {}), fields: toMapping(f.fields ?? []) };
    if (f.fields) return { key: f.key, fields: toMapping(f.fields) };
    return { key: f.key, expr: f.expr ?? "" };
  });
}

export function findField(fields: UIField[], uid: string): UIField | undefined {
  for (const f of fields) {
    if (f.uid === uid) return f;
    const inner = f.fields && findField(f.fields, uid);
    if (inner) return inner;
  }
  return undefined;
}

export function updateField(fields: UIField[], uid: string, fn: (f: UIField) => UIField): UIField[] {
  return fields.map((f) => (f.uid === uid ? fn(f) : f.fields ? { ...f, fields: updateField(f.fields, uid, fn) } : f));
}

export function removeField(fields: UIField[], uid: string): UIField[] {
  return fields.filter((f) => f.uid !== uid).map((f) => (f.fields ? { ...f, fields: removeField(f.fields, uid) } : f));
}

/** Adds a field at the top level (parent null) or inside an object or list row. */
export function addField(fields: UIField[], parent: string | null, field: UIField): UIField[] {
  if (parent === null) return [...fields, field];
  return updateField(fields, parent, (p) => ({ ...p, fields: [...(p.fields ?? []), field] }));
}

/** The chain of rows from the top down to a row (inclusive). */
export function ancestry(fields: UIField[], uid: string): UIField[] | null {
  for (const f of fields) {
    if (f.uid === uid) return [f];
    if (f.fields) {
      const inner = ancestry(f.fields, uid);
      if (inner) return [f, ...inner];
    }
  }
  return null;
}

/**
 * The expression to put in a row for a source path. Inside a list row the
 * item is the context, so paths under the list's source become relative
 * ("sku" rather than $get.body.items.sku).
 */
export function exprFor(fields: UIField[], rowUid: string | null, sourcePath: string): string {
  const chain = rowUid ? (ancestry(fields, rowUid) ?? []) : [];
  let context: string | null = null;
  for (const f of chain) {
    if (f.uid === rowUid && f.each !== undefined) break; // the list's own source is outside its items
    if (f.each?.trim())
      context = f.each.trim().startsWith("$") || context === null ? f.each.trim() : `${context}.${f.each.trim()}`;
  }
  if (context === null) return sourcePath;
  if (sourcePath === context) return "$";
  if (sourcePath.startsWith(`${context}.`)) return sourcePath.slice(context.length + 1);
  return sourcePath;
}

export function requiredUnmapped(fields: UIField[]): string[] {
  const out: string[] = [];
  const visit = (fs: UIField[], prefix: string) => {
    for (const f of fs) {
      const name = prefix ? `${prefix}.${f.key}` : f.key;
      if (f.required && !isMapped(f)) out.push(name);
      else if (f.fields && isMapped(f)) visit(f.fields, name);
    }
  };
  visit(fields, "");
  return out;
}

export function countMapped(fields: UIField[]): number {
  return fields.reduce((n, f) => n + (f.fields ? countMapped(f.fields) : f.expr?.trim() ? 1 : 0), 0);
}
