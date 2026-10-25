import jsonata from "jsonata";

/** JSONata's built-in functions. They can be passed as values, e.g. $map(xs, $string). */
const BUILTINS = new Set([
  "sum",
  "count",
  "max",
  "min",
  "average",
  "string",
  "substring",
  "substringBefore",
  "substringAfter",
  "lowercase",
  "uppercase",
  "length",
  "trim",
  "pad",
  "match",
  "contains",
  "replace",
  "split",
  "join",
  "formatNumber",
  "formatBase",
  "formatInteger",
  "parseInteger",
  "number",
  "floor",
  "ceil",
  "round",
  "abs",
  "sqrt",
  "power",
  "random",
  "boolean",
  "not",
  "map",
  "zip",
  "filter",
  "single",
  "reduce",
  "sift",
  "keys",
  "lookup",
  "append",
  "exists",
  "spread",
  "merge",
  "reverse",
  "each",
  "error",
  "assert",
  "type",
  "sort",
  "shuffle",
  "distinct",
  "base64encode",
  "base64decode",
  "encodeUrlComponent",
  "encodeUrl",
  "decodeUrlComponent",
  "decodeUrl",
  "eval",
  "toMillis",
  "fromMillis",
  "clone",
  "now",
  "millis",
]);

export interface ExpressionError {
  message: string;
  position?: number;
}

export interface ParsedExpression {
  ok: boolean;
  error?: ExpressionError;
  /** $names the expression reads that it does not bind itself. */
  references: string[];
}

interface AstNode {
  type?: string;
  value?: unknown;
  [key: string]: unknown;
}

/** Parses a JSONata expression and lists the free $variables it reads. */
export function parseExpression(source: string): ParsedExpression {
  let ast: AstNode;
  try {
    ast = jsonata(source).ast() as AstNode;
  } catch (e) {
    const err = e as { message?: string; position?: number };
    return { ok: false, error: { message: err.message ?? String(e), position: err.position }, references: [] };
  }

  const read = new Set<string>();
  const bound = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as AstNode;

    if (n.type === "variable" && typeof n.value === "string") {
      read.add(n.value);
    } else if (n.type === "bind") {
      const lhs = n.lhs as AstNode | undefined;
      if (lhs && typeof lhs.value === "string") bound.add(lhs.value);
      visit(n.rhs);
      return;
    } else if (n.type === "lambda") {
      for (const arg of (n.arguments as AstNode[] | undefined) ?? []) {
        if (typeof arg.value === "string") bound.add(arg.value);
      }
      visit(n.body);
      return;
    } else if (n.type === "function" || n.type === "partial") {
      // $name(...) is a call, not a read; only check the arguments.
      visit(n.arguments);
      return;
    }
    if (typeof n.focus === "string") bound.add(n.focus);
    if (typeof n.index === "string") bound.add(n.index);
    for (const [key, value] of Object.entries(n)) {
      if (key === "position" || key === "value") continue;
      visit(value);
    }
  };
  visit(ast);

  const references = [...read].filter(
    // "" is $ (context), "$" is $$ (root)
    (name) => name !== "" && name !== "$" && !bound.has(name) && !BUILTINS.has(name),
  );
  return { ok: true, references: references.sort() };
}

/** Splits a template like "Order {{$order.id}} failed" into its expressions. */
export function templateExpressions(template: string): { source: string; offset: number }[] {
  const out: { source: string; offset: number }[] = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    out.push({ source: (m[1] ?? "").trim(), offset: m.index });
  }
  return out;
}
