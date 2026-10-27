import jsonata from "jsonata";

// The mapper's view of a JSONata object constructor. A map like
//   { "id": $order.id, "customer": { "name": $order.buyer }, "lines": [$order.items.{ "sku": sku }] }
// becomes a tree of target fields, each with the expression that fills it.
// Anything the tree cannot represent exactly (computed keys, a top level that
// is not an object, ...) returns null, and the mapper shows the code instead.

export interface MapField {
  key: string;
  /** JSONata that fills a plain field. Unset for objects and lists. */
  expr?: string;
  /** Fields of a nested object, or of each item of a list. */
  fields?: MapField[];
  /** Lists: the source list. `fields` are evaluated once per item, relative to it. */
  each?: string;
  /** Lists: wrapped in [ ] so the result is always an array, even with one item. */
  wrap?: boolean;
}

interface Span {
  key: string;
  value: string;
}

/** Index of the bracket that closes the one at `open`, skipping strings, names and comments. */
function closing(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(src, i);
      if (i < 0) return -1;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function skipQuoted(src: string, start: number): number {
  const q = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\\" && q !== "`") i++;
    else if (src[i] === q) return i;
  }
  return -1;
}

/** Splits "{ k: v, k2: v2 }" into its pairs at the top level. Keys must be string literals. */
function splitObject(src: string): Span[] | null {
  const s = src.trim();
  if (!s.startsWith("{") || closing(s, 0) !== s.length - 1) return null;
  const body = s.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(body, i);
      if (i < 0) return null;
    } else if (c === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
  }
  const tail = body.slice(last);
  if (tail.trim() || parts.length > 0) parts.push(tail);
  const spans: Span[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p) return null;
    const q = p[0];
    if (q !== '"' && q !== "'") return null;
    const end = skipQuoted(p, 0);
    if (end < 0) return null;
    const rest = p.slice(end + 1).trimStart();
    if (!rest.startsWith(":")) return null;
    let key: string;
    try {
      key =
        q === '"'
          ? JSON.parse(p.slice(0, end + 1))
          : JSON.parse(`"${p.slice(1, end).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
    } catch {
      return null;
    }
    const value = rest.slice(1).trim();
    if (!value) return null;
    spans.push({ key, value });
  }
  return spans;
}

function toField({ key, value }: Span): MapField | null {
  // A nested object.
  if (value.startsWith("{") && closing(value, 0) === value.length - 1) {
    const fields = toFields(value);
    return fields ? { key, fields } : { key, expr: value };
  }
  // A list: P.{ ... } or [P.{ ... }]
  let inner = value;
  let wrap = false;
  if (value.startsWith("[") && closing(value, 0) === value.length - 1) {
    inner = value.slice(1, -1).trim();
    wrap = true;
  }
  if (inner.endsWith("}")) {
    // Find the "{" whose closing bracket is the last character.
    for (let i = inner.lastIndexOf("{"); i > 0; i = inner.lastIndexOf("{", i - 1)) {
      if (closing(inner, i) !== inner.length - 1) continue;
      const before = inner.slice(0, i).trimEnd();
      if (before.endsWith(".") && before.length > 1) {
        const fields = toFields(inner.slice(i));
        if (fields) return { key, each: before.slice(0, -1).trimEnd(), fields, ...(wrap ? { wrap } : {}) };
      }
      break;
    }
  }
  return { key, expr: value };
}

function toFields(src: string): MapField[] | null {
  const spans = splitObject(src);
  if (!spans) return null;
  const out: MapField[] = [];
  for (const s of spans) {
    const f = toField(s);
    if (!f) return null;
    out.push(f);
  }
  return out;
}

const stripPositions = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(stripPositions);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>)
      .filter(([k]) => k !== "position")
      .map(([k, v]) => [k, stripPositions(v)]),
  );
};

function sameProgram(a: string, b: string): boolean {
  try {
    return JSON.stringify(stripPositions(jsonata(a).ast())) === JSON.stringify(stripPositions(jsonata(b).ast()));
  } catch {
    return false;
  }
}

/**
 * The fields of an object-constructor expression, or null when the mapper
 * cannot show it exactly. An empty expression is an empty map.
 */
export function parseMapping(expression: string): MapField[] | null {
  if (!expression.trim()) return [];
  const fields = toFields(expression);
  if (!fields) return null;
  // Safety net: the tree must print back to the same program.
  return sameProgram(expression, printMapping(fields)) ? fields : null;
}

const indent = (text: string, pad: string) => text.replace(/\n/g, `\n${pad}`);

/** JSONata for a field tree. Plain fields without an expression are left out. */
export function printMapping(fields: MapField[], depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const lines: string[] = [];
  for (const f of fields) {
    const key = JSON.stringify(f.key);
    if (f.each !== undefined) {
      const body = `${f.each.trim()}.${printMapping(f.fields ?? [], depth + 1)}`;
      lines.push(`${pad}${key}: ${f.wrap ? `[${body}]` : body}`);
    } else if (f.fields) {
      lines.push(`${pad}${key}: ${printMapping(f.fields, depth + 1)}`);
    } else if (f.expr?.trim()) {
      lines.push(`${pad}${key}: ${indent(f.expr.trim(), pad)}`);
    }
  }
  if (lines.length === 0) return "{}";
  return `{\n${lines.join(",\n")}\n${"  ".repeat(depth)}}`;
}

/** A JSONata path to a field: $get.body.orders, `first name` quoted with backticks. */
export function pathExpression(root: string | null, segments: string[]): string {
  const parts = segments.map((s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `\`${s.replace(/`/g, "")}\``));
  if (root === null) return parts.join(".");
  return [`$${root}`, ...parts].join(".");
}

/** Top-level target keys a mapping fills (for required-field checks). */
export function mappedKeys(fields: MapField[]): Set<string> {
  return new Set(fields.filter((f) => f.each !== undefined || f.fields || f.expr?.trim()).map((f) => f.key));
}
