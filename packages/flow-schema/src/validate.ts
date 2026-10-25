import { parseExpression, templateExpressions } from "./expressions.js";
import { FlowDoc, type Step } from "./schema.js";
import { type StepContext, walkSteps } from "./walk.js";

export type IssueCode =
  | "schema"
  | "duplicate_id"
  | "trigger_style_mismatch"
  | "rethrow_outside_fault"
  | "return_requires_sync_http"
  | "sync_without_return"
  | "invalid_expression"
  | "unknown_reference"
  | "undeclared_variable"
  | "unknown_connection"
  | "connection_role"
  | "unknown_library"
  | "business_id_primary";

export interface Issue {
  code: IssueCode;
  message: string;
  /** JSON path into the document, e.g. ["steps", 2, "cases", 0, "when"]. */
  path: (string | number)[];
  stepId?: string;
}

export interface ValidationContext {
  /** Connections that exist, by identifier. When given, references are checked. */
  connections?: Record<string, { role: "trigger" | "invoke" | "trigger_invoke"; adapter: string }>;
  /** Library names that exist. When given, js steps are checked. */
  libraries?: string[];
}

export type ValidationResult =
  | { ok: true; doc: FlowDoc; errors: []; warnings: Issue[] }
  | { ok: false; doc?: FlowDoc; errors: Issue[]; warnings: Issue[] };

/**
 * Validates a FlowDoc: shape first, then the rules the shape cannot express.
 * Errors block saving as "configured" and activation; warnings do not.
 * Messages are written so a person and the AI builder can both act on them.
 */
export function validateFlow(input: unknown, ctx: ValidationContext = {}): ValidationResult {
  const parsed = FlowDoc.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: "schema",
        message: i.message,
        path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)),
      })),
      warnings: [],
    };
  }

  const doc = parsed.data;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  // Trigger matches the style.
  const t = doc.trigger;
  if (doc.style === "scheduled" && t.type !== "schedule") {
    errors.push({
      code: "trigger_style_mismatch",
      message: `A scheduled integration needs a "schedule" trigger, not "${t.type}".`,
      path: ["trigger", "type"],
    });
  }
  if (doc.style === "application" && t.type === "schedule") {
    errors.push({
      code: "trigger_style_mismatch",
      message: 'An application integration needs an "http" or "adapter" trigger. Use style "scheduled" for a schedule.',
      path: ["trigger", "type"],
    });
  }
  if (t.type === "adapter") checkConnection(t.connection, "trigger", ["trigger", "connection"], undefined);

  // Unique ids, including the trigger's.
  const seen = new Map<string, (string | number)[]>([[t.id, ["trigger", "id"]]]);
  walkSteps(doc, ({ step, path }) => {
    if (seen.has(step.id)) {
      errors.push({
        code: "duplicate_id",
        message: `Step id "${step.id}" is used more than once. Every step needs its own id.`,
        path: [...path, "id"],
        stepId: step.id,
      });
    } else {
      seen.set(step.id, [...path, "id"]);
    }
  });

  const syncHttp = t.type === "http" && t.sync;
  let hasReturn = false;
  const declared = new Set(Object.keys(doc.variables));

  walkSteps(doc, (c) => {
    const { step, path } = c;
    const at = (...rest: (string | number)[]) => [...path, ...rest];

    if (step.type === "rethrow" && !c.inFault) {
      errors.push({
        code: "rethrow_outside_fault",
        message: '"rethrow" only works inside an onFault block.',
        path: at("type"),
        stepId: step.id,
      });
    }
    if (step.type === "return") {
      hasReturn = true;
      if (!syncHttp) {
        errors.push({
          code: "return_requires_sync_http",
          message: '"return" sends a response, so it needs an "http" trigger with sync: true.',
          path: at("type"),
          stepId: step.id,
        });
      }
    }
    if (step.type === "invoke") checkConnection(step.connection, "invoke", at("connection"), step.id);
    if (step.type === "js" && ctx.libraries && !ctx.libraries.includes(step.library)) {
      errors.push({
        code: "unknown_library",
        message: `Library "${step.library}" does not exist.`,
        path: at("library"),
        stepId: step.id,
      });
    }
    if (step.type === "assign") {
      step.assignments.forEach((a, i) => {
        if (!declared.has(a.variable)) {
          errors.push({
            code: "undeclared_variable",
            message: `Variable "${a.variable}" is not declared. Add it under "variables" first.`,
            path: at("assignments", i, "variable"),
            stepId: step.id,
          });
        }
      });
    }

    for (const e of expressionsOf(step)) checkExpression(e.source, at(...e.key), c, e.template);
  });

  if (syncHttp && !hasReturn) {
    warnings.push({
      code: "sync_without_return",
      message: 'The trigger is sync but no "return" step sends a response. Callers will get an empty 200.',
      path: ["trigger", "sync"],
    });
  }

  // Business identifiers: if any, exactly one primary.
  doc.businessIds.forEach((b, i) => {
    checkExpression(b.expr, ["businessIds", i, "expr"], null, false);
  });
  if (doc.businessIds.length > 0) {
    const primaries = doc.businessIds.filter((b) => b.primary).length;
    if (primaries !== 1) {
      errors.push({
        code: "business_id_primary",
        message: `Mark exactly one business identifier as primary (found ${primaries}).`,
        path: ["businessIds"],
      });
    }
  }

  return errors.length === 0 ? { ok: true, doc, errors: [], warnings } : { ok: false, doc, errors, warnings };

  function checkConnection(
    id: string,
    need: "trigger" | "invoke",
    path: (string | number)[],
    stepId: string | undefined,
  ): void {
    if (!ctx.connections) return;
    const conn = ctx.connections[id];
    if (!conn) {
      errors.push({
        code: "unknown_connection",
        message: `Connection "${id}" does not exist. Create it, or use one of: ${Object.keys(ctx.connections).join(", ") || "(none yet)"}.`,
        path,
        stepId,
      });
    } else if (conn.role !== need && conn.role !== "trigger_invoke") {
      errors.push({
        code: "connection_role",
        message: `Connection "${id}" has the ${conn.role} role, so it cannot be used as ${need === "trigger" ? "a trigger" : "an invoke"}.`,
        path,
        stepId,
      });
    }
  }

  function checkExpression(source: string, path: (string | number)[], c: StepContext | null, template: boolean): void {
    const parts = template ? templateExpressions(source).map((p) => p.source) : [source];
    for (const part of parts) {
      if (part === "") continue;
      const r = parseExpression(part);
      if (!r.ok) {
        errors.push({
          code: "invalid_expression",
          message: `Not a valid JSONata expression: ${r.error?.message}`,
          path,
          stepId: c?.step.id,
        });
        continue;
      }
      // Business ids are read after the trigger and may use any step's output.
      const known = new Set(
        c
          ? ["trigger", "vars", ...c.loopVars, ...c.before, ...(c.inFault ? ["fault"] : [])]
          : ["trigger", "vars", ...seen.keys()],
      );
      for (const name of r.references) {
        if (!known.has(name)) {
          errors.push({
            code: "unknown_reference",
            message: `$${name} is not available here. Use $trigger, $vars, an earlier step's id${c?.loopVars.length ? `, a loop item (${c.loopVars.map((v) => `$${v}`).join(", ")})` : ""}${c?.inFault ? ", or $fault" : ""}.`,
            path,
            stepId: c?.step.id,
          });
        }
      }
    }
  }
}

/** Every expression and template a step carries, with its key path. */
function expressionsOf(step: Step): { source: string; key: (string | number)[]; template: boolean }[] {
  const e = (source: string | undefined, key: (string | number)[], template = false) =>
    source === undefined ? [] : [{ source, key, template }];
  switch (step.type) {
    case "invoke":
      return e(step.request, ["request"]);
    case "map":
      return e(step.expression, ["expression"]);
    case "assign":
      return step.assignments.flatMap((a, i) => e(a.value, ["assignments", i, "value"]));
    case "throw":
      return e(step.message, ["message"], true);
    case "log":
      return e(step.message, ["message"], true);
    case "notify":
      return [
        ...step.to.flatMap((to, i) => e(to, ["to", i], true)),
        ...e(step.subject, ["subject"], true),
        ...e(step.body, ["body"], true),
      ];
    case "return":
      return e(step.body, ["body"]);
    case "js":
      return step.args.flatMap((a, i) => e(a, ["args", i]));
    case "switch":
      return step.cases.flatMap((c, i) => e(c.when, ["cases", i, "when"]));
    case "forEach":
      return e(step.over, ["over"]);
    case "while":
      return e(step.condition, ["condition"]);
    default:
      return [];
  }
}
