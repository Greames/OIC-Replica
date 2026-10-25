import { inferShape, parseMapping, printMapping, shapeFromJsonSchema } from "@oicr/flow-schema";
import { describe, expect, it } from "vitest";
import {
  addField,
  exprFor,
  findField,
  newUid,
  removeField,
  requiredUnmapped,
  toMapping,
  toUI,
  updateField,
} from "./model";

describe("mapper model", () => {
  const schema = shapeFromJsonSchema({
    type: "object",
    required: ["id", "lines"],
    properties: {
      id: { type: "string" },
      customer: { type: "object", properties: { email: { type: "string" } } },
      lines: { type: "array", items: { type: "object", properties: { sku: { type: "string" } } } },
    },
  });

  it("merges the mapping with the target schema and leaves placeholders out of the expression", () => {
    const ui = toUI(parseMapping('{ "id": $get.id, "extra": 1 }')!, schema);
    expect(ui.map((f) => [f.key, f.required ?? false, f.expr ?? (f.each !== undefined ? "list" : "object")])).toEqual([
      ["id", true, "$get.id"],
      ["extra", false, "1"],
      ["customer", false, "object"],
      ["lines", true, "list"],
    ]);
    expect(requiredUnmapped(ui)).toEqual(["lines"]);
    expect(printMapping(toMapping(ui))).toBe('{\n  "id": $get.id,\n  "extra": 1\n}');
  });

  it("maps list items relative to the list, and edits the tree", () => {
    let ui = toUI([], schema);
    const lines = ui.find((f) => f.key === "lines")!;
    ui = updateField(ui, lines.uid, (f) => ({ ...f, each: exprFor(ui, f.uid, "$get.body.items") }));
    const sku = findField(ui, lines.uid)!.fields![0]!;
    expect(exprFor(ui, sku.uid, "$get.body.items.sku")).toBe("sku");
    expect(exprFor(ui, sku.uid, "$get.body.items")).toBe("$");
    expect(exprFor(ui, sku.uid, "$trigger.x")).toBe("$trigger.x");
    expect(exprFor(ui, lines.uid, "$get.body.items")).toBe("$get.body.items");
    ui = updateField(ui, sku.uid, (f) => ({ ...f, expr: "sku" }));
    ui = addField(ui, null, { uid: newUid(), key: "n", expr: "$count($get.body.items)" });
    expect(requiredUnmapped(ui)).toEqual(["id"]);
    expect(toMapping(ui)).toEqual([
      { key: "lines", each: "$get.body.items", wrap: true, fields: [{ key: "sku", expr: "sku" }] },
      { key: "n", expr: "$count($get.body.items)" },
    ]);
    expect(toMapping(removeField(ui, sku.uid))).toEqual([
      { key: "lines", each: "$get.body.items", wrap: true, fields: [] },
      { key: "n", expr: "$count($get.body.items)" },
    ]);
    void inferShape;
  });
});
