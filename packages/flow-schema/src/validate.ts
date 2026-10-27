import { parseExpression, templateExpressions } from "./expressions.js";
import { mappedKeys, parseMapping } from "./mapping.js";
import { FlowDoc, type Step } from "./schema.js";
import { SEMANTIC_FUNCTIONS, semanticKey } from "./semantic.js";
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
  | "business_id_primary"
  | "unknown_lookup"
  | "semantic_call"
  | "unknown_semantic_object"
  | "semantic_mismatch"
  | "required_unmapped";

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
  /** Lookup names that exist. When given, $lookupValue("name", ...) is checked. */
  lookups?: string[];
  /**
   * System objects with semantic bindings, as "system/object" → entity. When
   * given, $toSemantic/$fromSemantic/$translate are checked against them.
   */
  semanticObjects?: Record<string, string>;
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
      errors: parsed.error.issues.map((i) => {
        const path = i.path.map((p) => (typeof p === "symbol" ? String(p) : p));
        return { code: "schema" as const, message: friendly(i), path, stepId: stepIdAtPath(input, path) };
      }),
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

    // A target schema's required fields should be filled.
    if (step.type === "map" && Array.isArray(step.targetSchema?.required)) {
      const fields = parseMapping(step.expression);
      if (fields) {
        const have = mappedKeys(fields);
        const missing = (step.targetSchema.required as unknown[]).filter(
          (k): k is string => typeof k === "string" && !have.has(k),
        );
        if (missing.length)
          warnings.push({
            code: "required_unmapped",
            message: `Required target field(s) not mapped: ${missing.join(", ")}.`,
            path: at("expression"),
            stepId: step.id,
          });
      }
    }
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
      if (ctx.lookups) {
        for (const name of r.lookups) {
          if (!ctx.lookups.includes(name)) {
            errors.push({
              code: "unknown_lookup",
              message: `Lookup "${name}" does not exist. Create it under Lookups, or use one of: ${ctx.lookups.join(", ") || "(none yet)"}.`,
              path,
              stepId: c?.step.id,
            });
          }
        }
      }
      for (const call of r.semantics) {
        const issue = (code: IssueCode, message: string) => errors.push({ code, message, path, stepId: c?.step.id });
        if (call.arity || call.dynamic) {
          issue(
            "semantic_call",
            `Use ${SEMANTIC_FUNCTIONS[call.fn].usage}${call.dynamic ? " with the system and object written as literal text" : ""}.`,
          );
          continue;
        }
        if (!ctx.semanticObjects) continue;
        const entities = call.objects.map((o) => ctx.semanticObjects?.[semanticKey(o)]);
        call.objects.forEach((o, i) => {
          if (!entities[i])
            issue(
              "unknown_semantic_object",
              `"${o.object}" of system "${o.system}" has no semantic bindings. Bind it under Semantic catalog, or pick a bound object.`,
            );
        });
        if (call.fn === "translate" && entities[0] && entities[1] && entities[0] !== entities[1])
          issue(
            "semantic_mismatch",
            `$translate needs two objects of the same entity: "${call.objects[0]!.object}" is a ${entities[0]}, "${call.objects[1]!.object}" is a ${entities[1]}.`,
          );
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

/**
 * Every JSONata expression in a document (template parts split out), with its
 * path and step. For tools that analyse or compile expressions.
 */
export function flowExpressions(doc: FlowDoc): { source: string; path: (string | number)[]; stepId?: string }[] {
  const out: { source: string; path: (string | number)[]; stepId?: string }[] = [];
  const add = (source: string, path: (string | number)[], template: boolean, stepId?: string) => {
    const parts = template ? templateExpressions(source).map((p) => p.source) : [source];
    for (const p of parts) if (p !== "") out.push({ source: p, path, stepId });
  };
  walkSteps(doc, (c) => {
    for (const e of expressionsOf(c.step)) add(e.source, [...c.path, ...e.key], e.template, c.step.id);
  });
  doc.businessIds.forEach((b, i) => {
    add(b.expr, ["businessIds", i, "expr"], false);
  });
  return out;
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

/** Plain-language wording for the shape errors people hit most. */
function friendly(issue: { code: string; message: string; origin?: string; minimum?: unknown }): string {
  if (issue.code === "too_small" && issue.origin === "array") {
    return issue.minimum === 1 ? "Add at least one step here." : issue.message;
  }
  if (issue.code === "too_small" && issue.origin === "string") return "This is required.";
  if (issue.code === "invalid_union" || issue.code === "invalid_discriminator")
    return "Unknown step type, or required fields are missing.";
  return issue.message;
}

/** The id of the innermost step a JSON path points into, for badges on the canvas. */
function stepIdAtPath(input: unknown, path: (string | number)[]): string | undefined {
  let node: unknown = input;
  let id: string | undefined;
  for (const key of path) {
    if (node === null || typeof node !== "object") break;
    node = (node as Record<string | number, unknown>)[key];
    const maybe = node as { id?: unknown; type?: unknown } | undefined;
    if (maybe && typeof maybe === "object" && typeof maybe.id === "string" && typeof maybe.type === "string")
      id = maybe.id;
  }
  return id;
}
