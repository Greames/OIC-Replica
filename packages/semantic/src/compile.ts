import { createHash } from "node:crypto";
import { type FlowDoc, flowExpressions, parseExpression, SEMANTIC_FUNCTIONS, semanticKey } from "@oicr/flow-schema";
import { type AttributeType, DEFAULT_DIALECT, type Dialect } from "./catalog.js";
import type { SemanticGraph } from "./graph.js";

// Activation compiles every semantic reference in a flow against the
// workspace's graph into a self-contained SemanticPlan, stored with the
// execution plan. The data plane then needs no catalog, no bindings and no
// model: only the plan.

export interface CompiledField {
  /** Path to the technical field, e.g. ["entity", "id"]. */
  path: string[];
  attribute: string;
  type: AttributeType;
  read?: string;
  write?: string;
  readOnly?: boolean;
}

export interface CompiledObject {
  system: string;
  object: string;
  entity: string;
  dialect: Dialect;
  fields: CompiledField[];
  /** SemanticGraph.objectHash at compile time. */
  hash: string;
}

export interface SemanticPlan {
  version: 1;
  /** Hash over the compiled objects; changes when any binding a flow uses changes. */
  hash: string;
  objects: Record<string, CompiledObject>;
}

export interface CompileIssue {
  message: string;
  path: (string | number)[];
  stepId?: string;
}

export type CompileResult = { ok: true; plan: SemanticPlan | null } | { ok: false; errors: CompileIssue[] };

/** Compiles the objects a flow names. A flow without semantic calls compiles to null. */
export function compileSemantics(doc: FlowDoc, graph: SemanticGraph): CompileResult {
  const errors: CompileIssue[] = [];
  const keys = new Set<string>();
  for (const e of flowExpressions(doc)) {
    const parsed = parseExpression(e.source);
    for (const call of parsed.semantics) {
      const at = { path: e.path, stepId: e.stepId };
      if (call.arity || call.dynamic) {
        errors.push({
          ...at,
          message: `Use ${SEMANTIC_FUNCTIONS[call.fn].usage} with literal system and object names.`,
        });
        continue;
      }
      const entities = call.objects.map((ref) => {
        const o = graph.object(ref.system, ref.object);
        if (!o || o.fields.length === 0) {
          errors.push({ ...at, message: `"${ref.object}" of system "${ref.system}" has no semantic bindings.` });
          return undefined;
        }
        keys.add(semanticKey(ref));
        return o.entity;
      });
      if (call.fn === "translate" && entities[0] && entities[1] && entities[0] !== entities[1])
        errors.push({
          ...at,
          message: `$translate needs two objects of the same entity, not ${entities[0]} and ${entities[1]}.`,
        });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan: keys.size === 0 ? null : compileObjects(graph, [...keys]) };
}

/** A plan for the given "system/object" keys (also used to try expressions before activation). */
export function compileObjects(graph: SemanticGraph, keys: string[]): SemanticPlan {
  const objects: Record<string, CompiledObject> = {};
  for (const key of [...keys].sort()) {
    const i = key.indexOf("/");
    const o = graph.object(key.slice(0, i), key.slice(i + 1));
    if (!o) continue;
    objects[key] = {
      system: o.system,
      object: o.object,
      entity: o.entity,
      dialect: graph.system(o.system)?.dialect ?? DEFAULT_DIALECT,
      hash: graph.objectHash(o.system, o.object)!,
      fields: [...o.fields]
        .sort((a, b) => a.field.localeCompare(b.field))
        .map((f) => ({
          path: f.field.split("."),
          attribute: f.attribute,
          type: graph.attribute(o.entity, f.attribute)!.type,
          ...(f.read ? { read: f.read } : {}),
          ...(f.write ? { write: f.write } : {}),
          ...(f.readOnly ? { readOnly: true } : {}),
        })),
    };
  }
  const hash = createHash("sha256")
    .update(JSON.stringify(Object.entries(objects).map(([k, o]) => [k, o.hash])))
    .digest("hex");
  return { version: 1, hash, objects };
}

/**
 * Whether a plan still matches the graph: the keys of objects whose bindings
 * changed (or disappeared) since it was compiled.
 */
export function staleObjects(plan: SemanticPlan, graph: SemanticGraph): string[] {
  return Object.entries(plan.objects)
    .filter(([, o]) => graph.objectHash(o.system, o.object) !== o.hash)
    .map(([k]) => k);
}
