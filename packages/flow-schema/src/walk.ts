import type { FlowDoc, Step } from "./schema.js";

/** Where a step sits in the document. `path` is a JSON path for error reports. */
export interface StepContext {
  step: Step;
  path: (string | number)[];
  parent: Step | null;
  /** true when the step is inside an onFault block (scope or global). */
  inFault: boolean;
  /** forEach item names in scope, innermost last. */
  loopVars: string[];
  /** ids of steps that ran before this one on every path that reaches it. */
  before: string[];
  /** true when the step repeats: inside a forEach or while. */
  inLoop: boolean;
}

/** Child step lists of a container step, with the key used in the path. */
export function childLists(step: Step): { key: (string | number)[]; steps: Step[]; fault: boolean }[] {
  switch (step.type) {
    case "switch":
      return [
        ...step.cases.map((c, i) => ({ key: ["cases", i, "steps"], steps: c.steps, fault: false })),
        ...(step.otherwise ? [{ key: ["otherwise"], steps: step.otherwise, fault: false }] : []),
      ];
    case "forEach":
    case "while":
      return [{ key: ["steps"], steps: step.steps, fault: false }];
    case "scope":
      return [
        { key: ["steps"], steps: step.steps, fault: false },
        ...(step.onFault ? [{ key: ["onFault"], steps: step.onFault, fault: true }] : []),
      ];
    default:
      return [];
  }
}

/** Visits every step depth-first, in document order. */
export function walkSteps(doc: FlowDoc, visit: (ctx: StepContext) => void): void {
  const go = (
    steps: Step[],
    path: (string | number)[],
    parent: Step | null,
    inFault: boolean,
    loopVars: string[],
    before: string[],
    inLoop: boolean,
  ): void => {
    const seen = [...before];
    steps.forEach((step, i) => {
      const here = [...path, i];
      visit({ step, path: here, parent, inFault, loopVars, before: [...seen], inLoop });
      const innerLoop = step.type === "forEach" ? [...loopVars, step.as] : loopVars;
      const repeats = inLoop || step.type === "forEach" || step.type === "while";
      for (const child of childLists(step)) {
        go(child.steps, [...here, ...child.key], step, inFault || child.fault, innerLoop, [...seen], repeats);
      }
      seen.push(step.id);
    });
  };
  go(doc.steps, ["steps"], null, false, [], [doc.trigger.id], false);
  if (doc.onFault) go(doc.onFault, ["onFault"], null, true, [], [doc.trigger.id], false);
}

/** Finds a step by id anywhere in the document. */
export function findStep(doc: FlowDoc, id: string): StepContext | undefined {
  let found: StepContext | undefined;
  walkSteps(doc, (ctx) => {
    if (!found && ctx.step.id === id) found = ctx;
  });
  return found;
}

/** All step ids, in document order. */
export function stepIds(doc: FlowDoc): string[] {
  const ids: string[] = [];
  walkSteps(doc, (ctx) => ids.push(ctx.step.id));
  return ids;
}
