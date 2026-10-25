import { describe, expect, it } from "vitest";
import { connections, ordersSync } from "./__fixtures__/orders-sync.js";
import { emptyFlow, validateFlow } from "./index.js";

const clone = <T>(v: T): T => structuredClone(v);
const codes = (r: ReturnType<typeof validateFlow>) => r.errors.map((e) => e.code);

describe("validateFlow", () => {
  it("accepts the orders-sync example and fills defaults", () => {
    const r = validateFlow(ordersSync, { connections });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loop = r.doc.steps[1];
    expect(loop?.type === "forEach" && loop.parallel).toBe(false);
  });

  it("accepts both empty documents", () => {
    expect(validateFlow(emptyFlow("scheduled")).ok).toBe(true);
    expect(validateFlow(emptyFlow("application")).ok).toBe(true);
  });

  it("reports shape errors with a path", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[0].type = "teleport";
    const r = validateFlow(doc);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("schema");
    expect(r.errors[0]?.path).toEqual(["steps", 0, "type"]);
  });

  it("rejects nested shape errors deep in containers", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[1].steps[0].steps[1].retry.attempts = 99;
    const r = validateFlow(doc);
    expect(codes(r)).toEqual(["schema"]);
    expect(r.errors[0]?.path).toEqual(["steps", 1, "steps", 0, "steps", 1, "retry", "attempts"]);
  });

  it("finds duplicate ids, including the trigger's", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[2].id = "n4";
    doc.steps[0].id = "t1";
    const r = validateFlow(doc, { connections });
    expect(codes(r).filter((c) => c === "duplicate_id")).toHaveLength(2);
  });

  it("checks the trigger fits the style", () => {
    const doc = clone(ordersSync) as any;
    doc.style = "application";
    expect(codes(validateFlow(doc))).toContain("trigger_style_mismatch");
    const app = emptyFlow("application") as any;
    app.style = "scheduled";
    expect(codes(validateFlow(app))).toContain("trigger_style_mismatch");
  });

  it("allows rethrow only inside onFault", () => {
    const doc = clone(ordersSync) as any;
    doc.steps.push({ id: "r1", type: "rethrow" });
    expect(codes(validateFlow(doc, { connections }))).toEqual(["rethrow_outside_fault"]);
    const ok = clone(ordersSync) as any;
    ok.steps[1].steps[0].onFault.push({ id: "r1", type: "rethrow" });
    expect(validateFlow(ok, { connections }).ok).toBe(true);
  });

  it("requires a sync http trigger for return, and warns on sync without return", () => {
    const doc = clone(ordersSync) as any;
    doc.steps.push({ id: "ret", type: "return", body: "$n1" });
    expect(codes(validateFlow(doc, { connections }))).toContain("return_requires_sync_http");

    const app = emptyFlow("application") as any;
    app.trigger.sync = true;
    const r = validateFlow(app);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(["sync_without_return"]);
    app.steps.push({ id: "ret", type: "return", body: "{ 'ok': true, 'echo': $trigger }" });
    expect(validateFlow(app).warnings).toEqual([]);
  });

  it("rejects invalid JSONata in expressions and templates", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[1].over = "$n1.rows[";
    doc.steps[1].steps[0].onFault[0].subject = "Order {{ $order.id + }} failed";
    const r = validateFlow(doc, { connections });
    expect(codes(r)).toEqual(["invalid_expression", "invalid_expression"]);
    expect(r.errors[1]?.path).toEqual(["steps", 1, "steps", 0, "onFault", 0, "subject"]);
  });

  it("rejects references to steps that have not run yet", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[0].request = "{ 'x': $n7 }";
    const r = validateFlow(doc, { connections });
    expect(codes(r)).toEqual(["unknown_reference"]);
    expect(r.errors[0]?.stepId).toBe("n1");
  });

  it("scopes loop items and $fault", () => {
    const doc = clone(ordersSync) as any;
    // $order outside the loop
    doc.steps[2].assignments[0].value = "$order.id";
    // $fault outside onFault
    doc.steps[1].steps[0].steps[0].expression = "$fault.message";
    expect(codes(validateFlow(doc, { connections }))).toEqual(["unknown_reference", "unknown_reference"]);
  });

  it("does not let steps after a scope read steps from inside it", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[1].steps.push({ id: "after", type: "log", message: "{{ $n5 }}" });
    expect(codes(validateFlow(doc, { connections }))).toEqual(["unknown_reference"]);
  });

  it("ignores names the expression binds itself and built-ins", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[1].steps[0].steps[0].expression =
      "( $t := $order.total; $map($n1.rows, function($r) { $r.id & '-' & $string($t) }) ~> $join(',') )";
    expect(validateFlow(doc, { connections }).ok).toBe(true);
  });

  it("requires assigned variables to be declared", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[2].assignments.push({ variable: "cursor", value: "1" });
    expect(codes(validateFlow(doc, { connections }))).toEqual(["undeclared_variable"]);
  });

  it("checks connections exist and have the right role", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[0].connection = "nope";
    doc.steps[1].steps[0].steps[1].connection = "inbound";
    const r = validateFlow(doc, { connections });
    expect(codes(r)).toEqual(["unknown_connection", "connection_role"]);
    expect(r.errors[0]?.message).toContain("orders_db");
  });

  it("skips connection checks when no context is given", () => {
    const doc = clone(ordersSync) as any;
    doc.steps[0].connection = "anything";
    expect(validateFlow(doc).ok).toBe(true);
  });

  it("requires exactly one primary business identifier", () => {
    const doc = clone(ordersSync) as any;
    doc.businessIds[0].primary = false;
    expect(codes(validateFlow(doc, { connections }))).toEqual(["business_id_primary"]);
    doc.businessIds = [
      { name: "a", expr: "$n1", primary: true },
      { name: "b", expr: "$n1", primary: true },
    ];
    expect(codes(validateFlow(doc, { connections }))).toEqual(["business_id_primary"]);
  });

  it("checks js libraries when a list is given", () => {
    const doc = clone(ordersSync) as any;
    doc.steps.push({ id: "j1", type: "js", library: "utils", function: "slug", args: ["$n1"] });
    expect(validateFlow(doc, { connections }).ok).toBe(true);
    expect(codes(validateFlow(doc, { connections, libraries: [] }))).toEqual(["unknown_library"]);
  });
});
