// The shape of data, for the mapper's trees: inferred from sample payloads
// or read from a JSON Schema.

export type ShapeType = "object" | "array" | "string" | "number" | "boolean" | "null" | "any";

export interface Shape {
  type: ShapeType;
  /** Objects: fields in first-seen order. */
  fields?: { name: string; shape: Shape; optional?: boolean; required?: boolean }[];
  /** Arrays: the shape of the items. */
  items?: Shape;
  /** Can also be null. */
  nullable?: boolean;
  /** A sample value, for primitives. */
  example?: string | number | boolean;
}

const MAX_DEPTH = 12;
const MAX_FIELDS = 200;

function typeOf(v: unknown): ShapeType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" || t === "object" ? (t as ShapeType) : "any";
}

function one(v: unknown, depth: number): Shape {
  const type = typeOf(v);
  if (depth > MAX_DEPTH) return { type: "any" };
  if (type === "object") {
    const fields = Object.entries(v as Record<string, unknown>)
      .slice(0, MAX_FIELDS)
      .map(([name, value]) => ({ name, shape: one(value, depth + 1) }));
    return { type, fields };
  }
  if (type === "array") {
    const arr = v as unknown[];
    const items = arr.slice(0, 50).map((x) => one(x, depth + 1));
    return { type, items: items.length ? items.reduce(merge) : { type: "any" } };
  }
  if (type === "string")
    return { type, example: (v as string).length > 60 ? `${(v as string).slice(0, 57)}...` : (v as string) };
  if (type === "number" || type === "boolean") return { type, example: v as number | boolean };
  return { type };
}

/** Combines two shapes: fields missing from one side become optional; conflicting types become "any". */
export function merge(a: Shape, b: Shape): Shape {
  if (a.type === "null" && b.type !== "null") return { ...b, nullable: true };
  if (b.type === "null" && a.type !== "null") return { ...a, nullable: true };
  if (a.type !== b.type) return { type: "any", nullable: a.nullable || b.nullable || undefined };
  const nullable = a.nullable || b.nullable || undefined;
  if (a.type === "object") {
    const fields = new Map<string, { name: string; shape: Shape; optional?: boolean }>();
    const bNames = new Set((b.fields ?? []).map((f) => f.name));
    for (const f of a.fields ?? [])
      fields.set(f.name, { ...f, optional: f.optional || !bNames.has(f.name) || undefined });
    for (const f of b.fields ?? []) {
      const existing = fields.get(f.name);
      fields.set(
        f.name,
        existing
          ? { name: f.name, shape: merge(existing.shape, f.shape), optional: existing.optional || f.optional }
          : { ...f, optional: true },
      );
    }
    return { type: "object", fields: [...fields.values()], ...(nullable ? { nullable } : {}) };
  }
  if (a.type === "array")
    return {
      type: "array",
      items: merge(a.items ?? { type: "any" }, b.items ?? { type: "any" }),
      ...(nullable ? { nullable } : {}),
    };
  return { ...a, example: a.example ?? b.example, ...(nullable ? { nullable } : {}) };
}

/** The shape of one or more samples of the same payload. */
export function inferShape(...samples: unknown[]): Shape {
  if (samples.length === 0) return { type: "any" };
  return samples.map((s) => one(s, 0)).reduce(merge);
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  example?: unknown;
  examples?: unknown[];
};

/** Reads the parts of a JSON Schema the mapper needs. */
export function shapeFromJsonSchema(schema: unknown, depth = 0): Shape {
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH) return { type: "any" };
  const s = schema as JsonSchema;
  const types = Array.isArray(s.type)
    ? s.type
    : s.type
      ? [s.type]
      : s.properties
        ? ["object"]
        : s.items
          ? ["array"]
          : [];
  const nullable = types.includes("null") || undefined;
  const main = types.filter((t) => t !== "null");
  const t = main.length === 1 ? (main[0] === "integer" ? "number" : main[0]) : "any";
  const ex = s.example ?? s.examples?.[0];
  const example = typeof ex === "string" || typeof ex === "number" || typeof ex === "boolean" ? ex : undefined;
  if (t === "object") {
    const required = new Set(s.required ?? []);
    return {
      type: "object",
      fields: Object.entries(s.properties ?? {}).map(([name, p]) => ({
        name,
        shape: shapeFromJsonSchema(p, depth + 1),
        ...(required.has(name) ? { required: true } : { optional: true }),
      })),
      ...(nullable ? { nullable } : {}),
    };
  }
  if (t === "array")
    return { type: "array", items: shapeFromJsonSchema(s.items, depth + 1), ...(nullable ? { nullable } : {}) };
  if (t === "string" || t === "number" || t === "boolean")
    return { type: t, ...(example !== undefined ? { example } : {}), ...(nullable ? { nullable } : {}) };
  return { type: "any", ...(nullable ? { nullable } : {}) };
}

/** A JSON Schema for a shape (for a map step's targetSchema). Nothing is marked required. */
export function shapeToJsonSchema(shape: Shape): Record<string, unknown> {
  const type = shape.type === "any" ? undefined : shape.nullable ? [shape.type, "null"] : shape.type;
  if (shape.type === "object")
    return {
      type,
      properties: Object.fromEntries((shape.fields ?? []).map((f) => [f.name, shapeToJsonSchema(f.shape)])),
    };
  if (shape.type === "array") return { type, items: shapeToJsonSchema(shape.items ?? { type: "any" }) };
  return type ? { type } : {};
}
