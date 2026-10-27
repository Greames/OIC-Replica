import jsonata from "jsonata";
import { isSemanticFunction, SEMANTIC_FUNCTIONS, type SemanticCall } from "./semantic.js";

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
  /** Lookup names used as $lookupValue("name", ...). */
  lookups: string[];
  /** Semantic function calls ($toSemantic, $fromSemantic, $translate). */
  semantics: SemanticCall[];
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
    return {
      ok: false,
      error: { message: err.message ?? String(e), position: err.position },
      references: [],
      lookups: [],
      semantics: [],
    };
  }

  const read = new Set<string>();
  const bound = new Set<string>();
  const lookups = new Set<string>();
  const semantics: SemanticCall[] = [];

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
      const proc = n.procedure as AstNode | undefined;
      const first = (n.arguments as AstNode[] | undefined)?.[0];
      if (proc?.value === "lookupValue" && first?.type === "string" && typeof first.value === "string")
        lookups.add(first.value);
      if (isSemanticFunction(proc?.value)) semantics.push(semanticCall(proc.value, (n.arguments as AstNode[]) ?? []));
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
  return { ok: true, references: references.sort(), lookups: [...lookups].sort(), semantics };
}

function semanticCall(fn: keyof typeof SEMANTIC_FUNCTIONS, args: AstNode[]): SemanticCall {
  const want = SEMANTIC_FUNCTIONS[fn].objects;
  const names = args.slice(1);
  if (args.length !== 1 + want * 2) return { fn, objects: [], arity: true };
  if (!names.every((a) => a.type === "string" && typeof a.value === "string" && a.value !== ""))
    return { fn, objects: [], dynamic: true };
  const objects = [];
  for (let i = 0; i < want; i++)
    objects.push({ system: names[i * 2]!.value as string, object: names[i * 2 + 1]!.value as string });
  return { fn, objects };
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

/** Evaluates an expression and returns plain JSON (sequences become arrays). */
export async function evaluateExpression(
  source: string,
  input: unknown,
  bindings: Record<string, unknown> = {},
): Promise<unknown> {
  const v = await jsonata(source).evaluate(input, bindings);
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
