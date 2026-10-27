import type { FlowDoc, Step } from "./schema.js";
import { childLists } from "./walk.js";

/** Something an expression at a step can read, for the mapper's source tree. */
export type Source =
  | { kind: "trigger"; name: "trigger"; triggerType: FlowDoc["trigger"]["type"] }
  | { kind: "vars"; name: "vars" }
  | { kind: "step"; name: string; stepType: Step["type"]; label?: string }
  | { kind: "loop"; name: string; over: string; loopId: string }
  | { kind: "fault"; name: "fault" };

/** What a step's expressions can read: the trigger, variables, earlier steps, loop items, the fault. */
export function sourcesAt(doc: FlowDoc, stepId: string): Source[] | null {
  const search = (
    steps: Step[],
    before: Step[],
    loops: { as: string; over: string; id: string }[],
    inFault: boolean,
  ): Source[] | null => {
    const seen = [...before];
    for (const step of steps) {
      if (step.id === stepId) {
        return [
          { kind: "trigger", name: "trigger", triggerType: doc.trigger.type },
          ...(Object.keys(doc.variables).length ? [{ kind: "vars" as const, name: "vars" as const }] : []),
          ...seen.map((s) => ({ kind: "step" as const, name: s.id, stepType: s.type, label: s.label })),
          ...loops.map((l) => ({ kind: "loop" as const, name: l.as, over: l.over, loopId: l.id })),
          ...(inFault ? [{ kind: "fault" as const, name: "fault" as const }] : []),
        ];
      }
      const innerLoops = step.type === "forEach" ? [...loops, { as: step.as, over: step.over, id: step.id }] : loops;
      for (const child of childLists(step)) {
        const hit = search(child.steps, seen, innerLoops, inFault || child.fault);
        if (hit) return hit;
      }
      seen.push(step);
    }
    return null;
  };
  return search(doc.steps, [], [], false) ?? (doc.onFault ? search(doc.onFault, [], [], true) : null);
}
