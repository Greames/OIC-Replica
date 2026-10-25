import { describe, expect, it } from "vitest";
import { ordersSync } from "./__fixtures__/orders-sync.js";
import { FlowDoc, findStep, flowJsonSchema, hashFlow, parseExpression, stableStringify, stepIds } from "./index.js";

describe("hashFlow", () => {
  it("ignores key order and changes with content", async () => {
    const a = await hashFlow({ b: 1, a: [1, { y: 2, x: 1 }] });
    const b = await hashFlow({ a: [1, { x: 1, y: 2 }], b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashFlow({ a: 1 })).not.toBe(await hashFlow({ a: 2 }));
  });

  it("drops undefined like JSON does", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("walk", () => {
  it("lists ids in document order and finds nested steps", () => {
    const doc = FlowDoc.parse(ordersSync);
    expect(stepIds(doc)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    const n6 = findStep(doc, "n6");
    expect(n6?.inFault).toBe(true);
    expect(n6?.loopVars).toEqual(["order"]);
    expect(n6?.path).toEqual(["steps", 1, "steps", 0, "onFault", 0]);
  });
});

describe("parseExpression", () => {
  it("lists free variables", () => {
    expect(parseExpression("$a.b + $c[$d > 1]").references).toEqual(["a", "c", "d"]);
    expect(parseExpression("$$.x & $.y").references).toEqual([]);
    expect(parseExpression("items@$i#$n.($i.v * $n)").references).toEqual([]);
  });

  it("reports the error position", () => {
    const r = parseExpression("1 +");
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBeTruthy();
  });
});

describe("flowJsonSchema", () => {
  it("produces a JSON Schema that covers every step type", () => {
    const schema = JSON.stringify(flowJsonSchema());
    for (const t of ["invoke", "map", "switch", "forEach", "while", "scope", "return", "notify"]) {
      expect(schema).toContain(`"${t}"`);
    }
    expect(schema.length).toBeGreaterThan(2000);
  });
});
