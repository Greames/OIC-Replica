import { FlowDoc } from "@oicr/flow-schema";
import { describe, expect, it } from "vitest";
import { type LayoutNode, layoutFlow } from "./layout";

const doc = FlowDoc.parse({
  schemaVersion: 1,
  style: "scheduled",
  trigger: { id: "t", type: "schedule" },
  steps: [
    { id: "get", type: "invoke", connection: "c", operation: "GET /" },
    {
      id: "each",
      type: "forEach",
      over: "$get.body",
      as: "item",
      steps: [
        {
          id: "sc",
          type: "scope",
          steps: [{ id: "send", type: "invoke", connection: "c", operation: "POST /" }],
          onFault: [{ id: "note", type: "log", message: "x" }],
        },
      ],
    },
    {
      id: "sw",
      type: "switch",
      cases: [{ when: "true", label: "big", steps: [{ id: "a", type: "stop" }] }],
      otherwise: [{ id: "b", type: "log", message: "small" }],
    },
  ],
});

const boxes = (nodes: LayoutNode[]) =>
  nodes.filter((n) => n.kind === "step" || n.kind === "trigger" || n.kind === "end");
const overlap = (a: LayoutNode, b: LayoutNode) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layoutFlow", () => {
  it("places every step once, top to bottom, without overlaps", () => {
    const l = layoutFlow(doc);
    const steps = l.nodes.filter((n) => n.kind === "step").map((n) => n.id);
    expect(steps.sort()).toEqual(["a", "b", "each", "get", "note", "sc", "send", "sw"]);
    const b = boxes(l.nodes);
    for (const x of b) for (const y of b) if (x !== y) expect(overlap(x, y), `${x.id} overlaps ${y.id}`).toBe(false);
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y;
    expect(y("get")).toBeLessThan(y("each"));
    expect(y("each")).toBeLessThan(y("sc"));
    expect(y("sc")).toBeLessThan(y("send"));
    expect(y("each")).toBeLessThan(y("sw"));
  });

  it("nests children inside their container frames", () => {
    const l = layoutFlow(doc);
    const frame = l.nodes.find((n) => n.id === "frame:each")!;
    for (const id of ["sc", "send", "note"]) {
      const n = l.nodes.find((x) => x.id === id)!;
      expect(
        n.x >= frame.x && n.x + n.w <= frame.x + frame.w && n.y >= frame.y && n.y + n.h <= frame.y + frame.h,
        id,
      ).toBe(true);
    }
  });

  it("puts branches side by side and labels them", () => {
    const l = layoutFlow(doc);
    const a = l.nodes.find((n) => n.id === "a")!;
    const b = l.nodes.find((n) => n.id === "b")!;
    expect(a.y).toBe(b.y);
    expect(a.x).toBeLessThan(b.x);
    expect(l.nodes.filter((n) => n.kind === "label").map((n) => (n as { text: string }).text)).toEqual(
      expect.arrayContaining(["big", "Otherwise", "On error"]),
    );
  });

  it("connects the sequence and leaves containers from their frame", () => {
    const l = layoutFlow(doc);
    const e = (s: string, t: string) => l.edges.find((x) => x.source === s && x.target === t);
    expect(e("trigger:t", "get")).toBeTruthy();
    expect(e("get", "each")).toBeTruthy();
    expect(e("frame:each", "sw")).toMatchObject({ fromFrame: true });
    expect(e("sc", "note")).toMatchObject({ dashed: true });
    expect(e("frame:sw", "end")).toBeTruthy();
    for (const edge of l.edges) {
      expect(
        l.nodes.some((n) => n.id === edge.source),
        edge.id,
      ).toBe(true);
      expect(
        l.nodes.some((n) => n.id === edge.target),
        edge.id,
      ).toBe(true);
    }
  });

  it("adds insert points everywhere a step can go, only when editing", () => {
    expect(layoutFlow(doc).nodes.some((n) => n.kind === "insert")).toBe(false);
    const l = layoutFlow(doc, { edit: true });
    const ins = l.nodes.filter((n) => n.kind === "insert").map((n) => (n as { id: string }).id);
    expect(ins).toEqual(
      expect.arrayContaining([
        "insert:root:steps:0",
        "insert:root:steps:3",
        "insert:each:steps:1",
        "insert:sc:onFault:1",
        "insert:sw:cases.0.steps:0",
        "insert:sw:otherwise:1",
      ]),
    );
    expect(new Set(ins).size).toBe(ins.length);
  });

  it("handles an empty flow", () => {
    const empty = FlowDoc.parse({
      schemaVersion: 1,
      style: "application",
      trigger: { id: "t", type: "http" },
      steps: [],
    });
    const l = layoutFlow(empty, { edit: true });
    expect(l.nodes.find((n) => n.kind === "insert")).toMatchObject({ empty: true });
    expect(l.edges.map((e) => e.id)).toEqual(["e:trigger->end"]);
  });
});
