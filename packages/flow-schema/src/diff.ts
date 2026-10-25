import { stableStringify } from "./hash.js";
import type { FlowDoc, Step } from "./schema.js";
import { childLists } from "./walk.js";

export interface StepRef {
  id: string;
  type: Step["type"];
  label?: string;
}

/** What a proposal changes, step by step (S29). */
export interface FlowDiff {
  added: StepRef[];
  removed: StepRef[];
  changed: StepRef[];
  moved: StepRef[];
  triggerChanged: boolean;
  variablesChanged: boolean;
  businessIdsChanged: boolean;
  faultHandlerChanged: boolean;
}

/** A step's own settings, without the steps it contains. */
function own(step: Step): string {
  const { steps, cases, otherwise, onFault, ...rest } = step as Step & Record<string, unknown>;
  const caseHeads = Array.isArray(cases)
    ? (cases as { when: string; label?: string }[]).map((c) => ({ when: c.when, label: c.label }))
    : undefined;
  return stableStringify({ ...rest, caseHeads });
}

/** Each step with its slot: the parent and which of its lists ("steps", "onFault", "cases.0.steps"). */
function index(doc: FlowDoc | null) {
  const map = new Map<string, { step: Step; slot: string }>();
  const order = new Map<string, string[]>();
  const visit = (steps: Step[], slot: string) => {
    for (const step of steps) {
      map.set(step.id, { step, slot });
      order.set(slot, [...(order.get(slot) ?? []), step.id]);
      for (const child of childLists(step)) visit(child.steps, `${step.id}:${child.key.join(".")}`);
    }
  };
  if (doc) {
    visit(doc.steps, "<root>:steps");
    if (doc.onFault) visit(doc.onFault, "<root>:onFault");
  }
  return { map, order };
}

/** Ids not on a longest common subsequence of two orderings: the ones that moved. */
function reordered(a: string[], b: string[]): Set<string> {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const keep = new Set<string>();
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keep.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return new Set(b.filter((id) => !keep.has(id)));
}

const ref = (s: Step): StepRef => ({ id: s.id, type: s.type, ...(s.label ? { label: s.label } : {}) });

export function diffFlows(before: FlowDoc | null, after: FlowDoc): FlowDiff {
  const { map: a, order: orderA } = index(before);
  const { map: b, order: orderB } = index(after);
  const diff: FlowDiff = {
    added: [],
    removed: [],
    changed: [],
    moved: [],
    triggerChanged: !before || stableStringify(before.trigger) !== stableStringify(after.trigger),
    variablesChanged: stableStringify(before?.variables ?? {}) !== stableStringify(after.variables ?? {}),
    businessIdsChanged: stableStringify(before?.businessIds ?? []) !== stableStringify(after.businessIds ?? []),
    faultHandlerChanged: stableStringify(before?.onFault ?? null) !== stableStringify(after.onFault ?? null),
  };
  const shuffled = new Set<string>();
  for (const [slot, ids] of orderB) {
    const common = ids.filter((id) => a.get(id)?.slot === slot);
    const before = (orderA.get(slot) ?? []).filter((id) => common.includes(id));
    for (const id of reordered(before, common)) shuffled.add(id);
  }
  for (const [id, { step, slot }] of b) {
    const old = a.get(id);
    if (!old) diff.added.push(ref(step));
    else {
      if (own(old.step) !== own(step)) diff.changed.push(ref(step));
      if (old.slot !== slot || shuffled.has(id)) diff.moved.push(ref(step));
    }
  }
  for (const [id, { step }] of a) if (!b.has(id)) diff.removed.push(ref(step));
  return diff;
}

export function isEmptyDiff(d: FlowDiff): boolean {
  return (
    !d.added.length &&
    !d.removed.length &&
    !d.changed.length &&
    !d.moved.length &&
    !d.triggerChanged &&
    !d.variablesChanged &&
    !d.businessIdsChanged &&
    !d.faultHandlerChanged
  );
}
