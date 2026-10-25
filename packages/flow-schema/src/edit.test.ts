import { describe, expect, it } from "vitest";
import { ordersSync } from "./__fixtures__/orders-sync.js";
import {
  EditError,
  FlowDoc,
  insertStep,
  locate,
  moveStep,
  newStep,
  removeStep,
  STEP_INFO,
  stepIds,
  uniqueId,
  updateStep,
  validateFlow,
} from "./index.js";

const doc = () => FlowDoc.parse(structuredClone(ordersSync));

describe("edit operations", () => {
  it("locates steps anywhere", () => {
    expect(locate(doc(), "n1")).toEqual({ parentId: null, list: "steps", index: 0 });
    expect(locate(doc(), "n5")).toEqual({ parentId: "n3", list: "steps", index: 1 });
    expect(locate(doc(), "n6")).toEqual({ parentId: "n3", list: "onFault", index: 0 });
    expect(locate(doc(), "nope")).toBeNull();
  });

  it("inserts without mutating the input and refuses duplicate ids", () => {
    const before = doc();
    const after = insertStep(
      before,
      { parentId: null, list: "steps", index: 1 },
      { id: "log1", type: "log", level: "info", message: "hi" },
    );
    expect(stepIds(after)).toEqual(["n1", "log1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    expect(stepIds(before)).not.toContain("log1");
    expect(() => insertStep(after, { parentId: null, list: "steps", index: 0 }, { id: "n4", type: "stop" })).toThrow(
      EditError,
    );
    expect(() => insertStep(after, { parentId: null, list: "steps", index: 0 }, { id: "t1", type: "stop" })).toThrow(
      /already used/,
    );
  });

  it("creates optional lists on demand and inserts into switch cases", () => {
    let d = insertStep(
      doc(),
      { parentId: null, list: "onFault", index: 0 },
      { id: "g1", type: "log", level: "error", message: "x" },
    );
    expect(d.onFault?.map((s) => s.id)).toEqual(["g1"]);
    d = insertStep(
      d,
      { parentId: null, list: "steps", index: 0 },
      { id: "sw", type: "switch", cases: [{ when: "true", steps: [{ id: "a", type: "stop" }] }] },
    );
    d = insertStep(
      d,
      { parentId: "sw", list: "cases.0.steps", index: 0 },
      { id: "b", type: "log", level: "info", message: "" },
    );
    d = insertStep(d, { parentId: "sw", list: "otherwise", index: 0 }, { id: "c", type: "stop" });
    expect(locate(d, "b")).toEqual({ parentId: "sw", list: "cases.0.steps", index: 0 });
    expect(locate(d, "c")).toEqual({ parentId: "sw", list: "otherwise", index: 0 });
    expect(() => insertStep(d, { parentId: "n1", list: "steps", index: 0 }, { id: "z", type: "stop" })).toThrow(
      /has no list/,
    );
  });

  it("removes steps with their children and tidies empty optional lists", () => {
    const d = removeStep(doc(), "n6");
    const scope = d.steps[1]?.type === "forEach" ? d.steps[1].steps[0] : null;
    expect(scope && "onFault" in scope).toBe(false);
    const e = removeStep(doc(), "n2");
    expect(stepIds(e)).toEqual(["n1", "n7"]);
  });

  it("moves steps up, down, and between containers", () => {
    const down = moveStep(doc(), "n1", { parentId: null, list: "steps", index: 3 });
    expect(down.steps.map((s) => s.id)).toEqual(["n2", "n7", "n1"]);
    const up = moveStep(doc(), "n7", { parentId: null, list: "steps", index: 0 });
    expect(up.steps.map((s) => s.id)).toEqual(["n7", "n1", "n2"]);
    const into = moveStep(doc(), "n7", { parentId: "n3", list: "steps", index: 0 });
    expect(locate(into, "n7")).toEqual({ parentId: "n3", list: "steps", index: 0 });
    expect(() => moveStep(doc(), "n2", { parentId: "n3", list: "steps", index: 0 })).toThrow(/inside itself/);
  });

  it("updates settings but not type, and refuses taken ids", () => {
    const d = updateStep(doc(), "n5", { retry: { attempts: 5, backoffSeconds: 2 }, label: "Send" });
    const n5 = locate(d, "n5");
    expect(n5).toEqual({ parentId: "n3", list: "steps", index: 1 });
    const r = validateFlow(d);
    expect(r.ok).toBe(true);
    expect(() => updateStep(doc(), "n5", { type: "map" } as never)).toThrow(/cannot change/);
    expect(() => updateStep(doc(), "n5", { id: "n4" })).toThrow(/already used/);
    const cleared = updateStep(d, "n5", { retry: undefined });
    expect(JSON.stringify(cleared)).not.toContain('"attempts":5');
  });

  it("makes unique ids and valid-shaped new steps for every type", () => {
    expect(uniqueId(doc(), "n1")).toBe("n12");
    expect(uniqueId(doc(), "log")).toBe("log");
    for (const type of Object.keys(STEP_INFO) as (keyof typeof STEP_INFO)[]) {
      const s = newStep(doc(), type);
      expect(s.type).toBe(type);
      const d = insertStep(doc(), { parentId: null, list: "steps", index: 0 }, s);
      const r = validateFlow(d);
      // New steps may still need input (e.g. an empty loop), but never break the document's shape elsewhere.
      for (const e of r.errors)
        expect(e.stepId === s.id || e.path[1] === 0, `${type}: ${e.message} at ${e.path.join(".")}`).toBe(true);
    }
  });

  it("points shape errors at the step, in plain words", () => {
    const d = insertStep(doc(), { parentId: null, list: "steps", index: 0 }, newStep(doc(), "forEach"));
    const r = validateFlow(d);
    const e = r.errors.find((x) => x.stepId === "each");
    expect(e?.message).toBe("Add at least one step here.");
    const blank = updateStep(doc(), "n5", { connection: "" });
    expect(validateFlow(blank).errors[0]).toMatchObject({ stepId: "n5", message: "This is required." });
  });
});
