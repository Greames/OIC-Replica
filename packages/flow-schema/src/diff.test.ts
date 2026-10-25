import { describe, expect, it } from "vitest";
import { connections, ordersSync } from "./__fixtures__/orders-sync.js";
import { diffFlows, FlowDoc, isEmptyDiff } from "./index.js";

const parse = (v: unknown) => FlowDoc.parse(v);

describe("diffFlows", () => {
  it("reports everything as added for a new integration", () => {
    const d = diffFlows(null, parse(ordersSync));
    expect(d.added.map((s) => s.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    expect(d.triggerChanged).toBe(true);
  });

  it("is empty for identical documents", () => {
    expect(isEmptyDiff(diffFlows(parse(ordersSync), parse(structuredClone(ordersSync))))).toBe(true);
  });

  it("finds added, removed, changed and moved steps without blaming parents", () => {
    const before = parse(ordersSync);
    const after = structuredClone(ordersSync) as any;
    after.steps[1].steps[0].steps[1].retry = { attempts: 5 }; // n5 changed
    after.steps.splice(2, 1); // n7 removed
    after.steps.unshift({ id: "log0", type: "log", message: "start" }); // added
    after.steps[2].steps[0].onFault.push({ id: "n6b", type: "rethrow" }); // added inside onFault
    const d = diffFlows(before, parse(after));
    expect(d.added.map((s) => s.id)).toEqual(["log0", "n6b"]);
    expect(d.removed.map((s) => s.id)).toEqual(["n7"]);
    expect(d.changed.map((s) => s.id)).toEqual(["n5"]);
    expect(d.moved).toEqual([]); // inserting a step shifts others but does not move them
    expect(d.triggerChanged).toBe(false);
    void connections;
  });

  it("finds real moves: reordering and changing parent", () => {
    const before = parse(ordersSync);
    const after = structuredClone(ordersSync) as any;
    after.steps.reverse(); // n7, n2, n1
    const moved = diffFlows(before, parse(after)).moved.map((s) => s.id);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThan(3);

    const out = structuredClone(ordersSync) as any;
    const n4 = out.steps[1].steps[0].steps.shift(); // take n4 out of the scope
    out.steps.splice(1, 0, n4); // put it at the top level
    expect(diffFlows(before, parse(out)).moved.map((s) => s.id)).toEqual(["n4"]);
  });
});
