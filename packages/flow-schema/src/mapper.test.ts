import jsonata from "jsonata";
import { describe, expect, it } from "vitest";
import { lookupFunction, lookupIn } from "./lookup.js";
import { mappedKeys, parseMapping, pathExpression, printMapping } from "./mapping.js";
import { inferShape, shapeFromJsonSchema, shapeToJsonSchema } from "./shape.js";
import { validateFlow } from "./validate.js";

describe("mapping", () => {
  it("reads plain, nested and list fields", () => {
    const fields = parseMapping(`{
      "id": $order.id,
      'name': $uppercase($order.buyer.name),
      "customer": { "email": $order.buyer.email, "vip": $order.total > 100 },
      "lines": [$order.items.{ "sku": sku, "qty": $number(qty) }],
      "tags": $order.tags.{ "t": $ }
    }`);
    expect(fields).toEqual([
      { key: "id", expr: "$order.id" },
      { key: "name", expr: "$uppercase($order.buyer.name)" },
      {
        key: "customer",
        fields: [
          { key: "email", expr: "$order.buyer.email" },
          { key: "vip", expr: "$order.total > 100" },
        ],
      },
      {
        key: "lines",
        each: "$order.items",
        wrap: true,
        fields: [
          { key: "sku", expr: "sku" },
          { key: "qty", expr: "$number(qty)" },
        ],
      },
      { key: "tags", each: "$order.tags", fields: [{ key: "t", expr: "$" }] },
    ]);
  });

  it("prints a tree that evaluates the same as the original", async () => {
    const src = `{ "a": $x.a, "b": { "c": "lit, with } brace", "d": [1, 2] }, "items": [$x.items.{ "n": name }] }`;
    const fields = parseMapping(src)!;
    const printed = printMapping(fields);
    const x = { a: 1, items: [{ name: "only" }] };
    expect(await jsonata(printed).evaluate({}, { x })).toEqual(await jsonata(src).evaluate({}, { x }));
    expect(parseMapping(printed)).toEqual(fields);
  });

  it("gives up on what it cannot show exactly", () => {
    expect(parseMapping("$order.id")).toBeNull();
    expect(parseMapping("{ $k: 1 }")).toBeNull();
    expect(parseMapping('{ "a": 1 } ~> $merge')).toBeNull();
    expect(parseMapping('{ "a": $match(x, /a,"b/) }')).toBeNull();
    expect(parseMapping("")).toEqual([]);
    expect(parseMapping("{}")).toEqual([]);
  });

  it("leaves out unmapped fields and quotes odd keys", () => {
    expect(
      printMapping([
        { key: "a", expr: "" },
        { key: "first name", expr: "$x" },
      ]),
    ).toBe('{\n  "first name": $x\n}');
    expect(printMapping([])).toBe("{}");
    expect(pathExpression("get", ["body", "first name", "id"])).toBe("$get.body.`first name`.id");
    expect(pathExpression(null, ["sku"])).toBe("sku");
    expect([
      ...mappedKeys([
        { key: "a", expr: " " },
        { key: "b", fields: [] },
      ]),
    ]).toEqual(["b"]);
  });
});

describe("shape", () => {
  it("infers fields, lists and optional fields across samples", () => {
    const s = inferShape(
      { id: 1, buyer: { name: "Ada" }, items: [{ sku: "A" }, { sku: "B", qty: 2 }] },
      { id: 2, note: null },
    );
    expect(s.type).toBe("object");
    const f = Object.fromEntries(s.fields!.map((x) => [x.name, x]));
    expect(f.id).toMatchObject({ shape: { type: "number", example: 1 } });
    expect(f.buyer!.optional).toBe(true);
    expect(f.note).toMatchObject({ optional: true, shape: { type: "null" } });
    const item = f.items!.shape.items!;
    expect(item.fields!.find((x) => x.name === "qty")?.optional).toBe(true);
    expect(inferShape([1, "a"]).items?.type).toBe("any");
  });

  it("reads JSON Schema, and writes one", () => {
    const s = shapeFromJsonSchema({
      type: "object",
      required: ["id"],
      properties: { id: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
    });
    expect(s.fields).toEqual([
      { name: "id", shape: { type: "number" }, required: true },
      { name: "tags", shape: { type: "array", items: { type: "string" } }, optional: true },
    ]);
    expect(shapeToJsonSchema(inferShape({ a: [{ b: true }] }))).toEqual({
      type: "object",
      properties: { a: { type: "array", items: { type: "object", properties: { b: { type: "boolean" } } } } },
    });
  });
});

describe("lookups", () => {
  const countries = {
    name: "countries",
    domains: ["shop", "erp"],
    rows: [
      ["US", "USA"],
      ["IN", "IND"],
      ["XX", ""],
    ],
  };

  it("finds values both ways, with defaults and lists", async () => {
    expect(lookupIn(countries, "shop", "IN", "erp")).toBe("IND");
    expect(lookupIn(countries, "erp", "USA", "shop")).toBe("US");
    expect(lookupIn(countries, "shop", "XX", "erp")).toBeUndefined();
    expect(() => lookupIn(countries, "shop", "US", "crm")).toThrow(/no domain "crm".*shop, erp/);
    const fn = lookupFunction((n) => (n === "countries" ? countries : null));
    const expr = jsonata(
      '{ "one": $lookupValue("countries", "shop", c, "erp"), "many": $lookupValue("countries", "shop", cs, "erp", "?") }',
    );
    expect(await expr.evaluate({ c: "US", cs: ["IN", "FR"] }, { lookupValue: fn })).toEqual({
      one: "USA",
      many: ["IND", "?"],
    });
    await expect(jsonata('$lookupValue("nope", "a", 1, "b")').evaluate({}, { lookupValue: fn })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("is checked by the validator, as are required target fields", () => {
    const doc = {
      schemaVersion: 1,
      style: "application",
      trigger: { id: "t", type: "http" },
      steps: [
        {
          id: "m",
          type: "map",
          expression: '{ "code": $lookupValue("countries", "shop", $trigger.c, "erp") }',
          targetSchema: { type: "object", required: ["code", "name"] },
        },
      ],
    };
    const ok = validateFlow(doc, { lookups: ["countries"] });
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.map((w) => w.message)).toEqual(["Required target field(s) not mapped: name."]);
    const bad = validateFlow(doc, { lookups: ["regions"] });
    expect(bad.errors.map((e) => e.code)).toEqual(["unknown_lookup"]);
    expect(validateFlow(doc).errors).toEqual([]);
  });
});

describe("sources", () => {
  it("lists what a step can read", async () => {
    const { sourcesAt } = await import("./sources.js");
    const { FlowDoc } = await import("./schema.js");
    const doc = FlowDoc.parse({
      schemaVersion: 1,
      style: "scheduled",
      trigger: { id: "t", type: "schedule" },
      variables: { n: { type: "number", initial: 0 } },
      steps: [
        { id: "get", type: "invoke", connection: "c", operation: "GET /" },
        {
          id: "each",
          type: "forEach",
          over: "$get.body.orders",
          as: "order",
          steps: [{ id: "m", type: "map", expression: "{}" }],
        },
        { id: "after", type: "log", message: "x" },
      ],
      onFault: [{ id: "f", type: "log", message: "x" }],
    });
    expect(sourcesAt(doc, "m")!.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "trigger:trigger",
      "vars:vars",
      "step:get",
      "loop:order",
    ]);
    expect(sourcesAt(doc, "m")![3]).toMatchObject({ over: "$get.body.orders", loopId: "each" });
    expect(sourcesAt(doc, "after")!.map((s) => s.name)).toEqual(["trigger", "vars", "get", "each"]);
    expect(sourcesAt(doc, "f")!.map((s) => s.name)).toEqual(["trigger", "vars", "fault"]);
    expect(sourcesAt(doc, "nope")).toBeNull();
  });
});
