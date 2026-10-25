import type { FlowDoc, Step, StepType } from "./schema.js";
import { childLists, findStep, stepIds } from "./walk.js";

// Pure edits on a FlowDoc, shared by the canvas and anything else that edits
// a flow. Each returns a new document; the input is never mutated.

/** Where a step goes: a list inside a parent (null = top level) at an index. */
export interface StepLocation {
  parentId: string | null;
  /** "steps", "onFault", "otherwise", or "cases.<n>.steps". */
  list: string;
  index: number;
}

export class EditError extends Error {}

const clone = <T>(v: T): T => structuredClone(v);

/** The array a location points at, creating optional lists (onFault, otherwise) on demand. */
function listAt(doc: FlowDoc, parentId: string | null, list: string): Step[] {
  if (parentId === null) {
    if (list === "steps") return doc.steps;
    if (list === "onFault") {
      doc.onFault ??= [];
      return doc.onFault;
    }
    throw new EditError(`The top level has no list "${list}".`);
  }
  const found = findStep(doc, parentId);
  if (!found) throw new EditError(`No step "${parentId}".`);
  const p = found.step as Step & Record<string, unknown>;
  const caseMatch = list.match(/^cases\.(\d+)\.steps$/);
  if (caseMatch && p.type === "switch") {
    const c = p.cases[Number(caseMatch[1])];
    if (!c) throw new EditError(`Switch "${parentId}" has no case ${caseMatch[1]}.`);
    return c.steps;
  }
  if (list === "steps" && (p.type === "forEach" || p.type === "while" || p.type === "scope")) return p.steps;
  if (list === "onFault" && p.type === "scope") {
    p.onFault ??= [];
    return p.onFault;
  }
  if (list === "otherwise" && p.type === "switch") {
    p.otherwise ??= [];
    return p.otherwise;
  }
  throw new EditError(`Step "${parentId}" (${p.type}) has no list "${list}".`);
}

/** Where a step currently is. */
export function locate(doc: FlowDoc, id: string): StepLocation | null {
  const search = (steps: Step[], parentId: string | null, list: string): StepLocation | null => {
    for (const [index, s] of steps.entries()) {
      if (s.id === id) return { parentId, list, index };
      for (const child of childLists(s)) {
        const hit = search(child.steps, s.id, child.key.join("."));
        if (hit) return hit;
      }
    }
    return null;
  };
  return search(doc.steps, null, "steps") ?? (doc.onFault ? search(doc.onFault, null, "onFault") : null);
}

export function insertStep(doc: FlowDoc, at: StepLocation, step: Step): FlowDoc {
  const next = clone(doc);
  const taken = new Set([next.trigger.id, ...stepIds(next)]);
  const incoming: string[] = [];
  const collect = (s: Step) => {
    incoming.push(s.id);
    for (const c of childLists(s)) c.steps.forEach(collect);
  };
  collect(step);
  const clash = incoming.find((i) => taken.has(i));
  if (clash) throw new EditError(`Step id "${clash}" is already used.`);
  const list = listAt(next, at.parentId, at.list);
  list.splice(Math.max(0, Math.min(at.index, list.length)), 0, clone(step));
  return next;
}

export function removeStep(doc: FlowDoc, id: string): FlowDoc {
  const at = locate(doc, id);
  if (!at) throw new EditError(`No step "${id}".`);
  const next = clone(doc);
  listAt(next, at.parentId, at.list).splice(at.index, 1);
  return tidy(next);
}

/** Moves a step (with everything inside it) to a new location. */
export function moveStep(doc: FlowDoc, id: string, to: StepLocation): FlowDoc {
  const from = locate(doc, id);
  if (!from) throw new EditError(`No step "${id}".`);
  if (to.parentId === id || (to.parentId && isInside(doc, to.parentId, id))) {
    throw new EditError("A step cannot be moved inside itself.");
  }
  const next = clone(doc);
  const source = listAt(next, from.parentId, from.list);
  const [step] = source.splice(from.index, 1);
  if (!step) throw new EditError(`No step "${id}".`);
  let index = to.index;
  // Moving down within the same list: removing the step shifted the target.
  if (from.parentId === to.parentId && from.list === to.list && from.index < to.index) index -= 1;
  const target = listAt(next, to.parentId, to.list);
  target.splice(Math.max(0, Math.min(index, target.length)), 0, step);
  return tidy(next);
}

/** Replaces a step's own settings. Children (steps, cases, onFault, otherwise) are kept unless given. */
export function updateStep(doc: FlowDoc, id: string, patch: Partial<Step> & Record<string, unknown>): FlowDoc {
  const at = locate(doc, id);
  if (!at) throw new EditError(`No step "${id}".`);
  const next = clone(doc);
  const list = listAt(next, at.parentId, at.list);
  const current = list[at.index] as Step & Record<string, unknown>;
  if (patch.type && patch.type !== current.type)
    throw new EditError("A step's type cannot change; add a new step instead.");
  if (patch.id && patch.id !== id) {
    const taken = new Set([next.trigger.id, ...stepIds(next)]);
    if (taken.has(patch.id)) throw new EditError(`Step id "${patch.id}" is already used.`);
  }
  const merged: Record<string, unknown> = { ...current, ...clone(patch) };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  list[at.index] = merged as unknown as Step;
  return next;
}

function isInside(doc: FlowDoc, id: string, ancestorId: string): boolean {
  const anc = findStep(doc, ancestorId);
  if (!anc) return false;
  let found = false;
  const visit = (s: Step) => {
    for (const c of childLists(s))
      for (const x of c.steps) {
        if (x.id === id) found = true;
        visit(x);
      }
  };
  visit(anc.step);
  return found;
}

/** Drops empty optional lists so documents stay minimal. */
function tidy(doc: FlowDoc): FlowDoc {
  if (doc.onFault && doc.onFault.length === 0) delete doc.onFault;
  const visit = (s: Step) => {
    const r = s as Step & Record<string, unknown>;
    if (Array.isArray(r.onFault) && r.onFault.length === 0) delete r.onFault;
    if (Array.isArray(r.otherwise) && r.otherwise.length === 0) delete r.otherwise;
    for (const c of childLists(s)) c.steps.forEach(visit);
  };
  doc.steps.forEach(visit);
  doc.onFault?.forEach(visit);
  return doc;
}

/** A fresh id like "log2" that is not used yet. */
export function uniqueId(doc: FlowDoc, base: string): string {
  const taken = new Set([doc.trigger.id, ...stepIds(doc)]);
  const stem = base.replace(/[^a-zA-Z0-9_]/g, "") || "step";
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem}${n}`)) return `${stem}${n}`;
}

/** What each step type is, for palettes and inspectors. */
export const STEP_INFO: Record<StepType, { label: string; description: string; container: boolean }> = {
  invoke: { label: "Call a connection", description: "Call an API or system through a connection.", container: false },
  map: { label: "Map data", description: "Build a new value from earlier data.", container: false },
  assign: { label: "Set variables", description: "Change declared variables.", container: false },
  switch: { label: "Switch", description: "Take the first branch whose condition is true.", container: true },
  forEach: { label: "For each", description: "Repeat steps for every item in a list.", container: true },
  while: { label: "While", description: "Repeat steps while a condition is true.", container: true },
  scope: { label: "Scope", description: "Group steps and handle their errors.", container: true },
  log: { label: "Log", description: "Write a line to the run's activity.", container: false },
  notify: { label: "Send email", description: "Email someone.", container: false },
  wait: { label: "Wait", description: "Pause for a number of seconds.", container: false },
  throw: { label: "Raise an error", description: "Fail on purpose with a code and message.", container: false },
  rethrow: {
    label: "Re-raise the error",
    description: "Pass a caught error on (inside an error handler).",
    container: false,
  },
  stop: { label: "Stop", description: "End the run successfully.", container: false },
  return: { label: "Respond", description: "Answer the caller (sync HTTP integrations).", container: false },
  js: { label: "JavaScript", description: "Run a library function (coming later).", container: false },
};

/** A new step of a type with sensible starting values. */
export function newStep(doc: FlowDoc, type: StepType): Step {
  const id = uniqueId(doc, type === "forEach" ? "each" : type);
  switch (type) {
    case "invoke":
      return { id, type, label: "Call a connection", connection: "", operation: "GET /", config: {} } as Step;
    case "map":
      return { id, type, label: "Map data", expression: "{}" } as Step;
    case "assign":
      return { id, type, label: "Set variables", assignments: [{ variable: "", value: "" }] } as Step;
    case "switch":
      return { id, type, label: "Switch", cases: [{ when: "true", label: "Case 1", steps: [] }] } as Step;
    case "forEach":
      return { id, type, label: "For each", over: "[]", as: "item", parallel: false, steps: [] } as Step;
    case "while":
      return { id, type, label: "While", condition: "false", maxIterations: 1000, steps: [] } as Step;
    case "scope":
      return { id, type, label: "Scope", steps: [], onFault: [] } as Step;
    case "log":
      return { id, type, label: "Log", level: "info", message: "" } as Step;
    case "notify":
      return { id, type, label: "Send email", channel: "email", to: [""], subject: "", body: "" } as Step;
    case "wait":
      return { id, type, label: "Wait", seconds: 5 } as Step;
    case "throw":
      return { id, type, label: "Raise an error", code: "error", message: "" } as Step;
    case "rethrow":
      return { id, type, label: "Re-raise the error" } as Step;
    case "stop":
      return { id, type, label: "Stop" } as Step;
    case "return":
      return { id, type, label: "Respond", status: 200, body: "{}" } as Step;
    case "js":
      return { id, type, label: "JavaScript", library: "", function: "", args: [] } as Step;
  }
}
