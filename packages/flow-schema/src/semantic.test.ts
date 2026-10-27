import { describe, expect, it } from "vitest";
import { parseExpression } from "./expressions.js";
import { validateFlow } from "./validate.js";

const flow = (expression: string) => ({
  schemaVersion: 1,
  style: "application",
  trigger: { id: "t", type: "http", method: "POST", sync: false },
  steps: [{ id: "m", type: "map", expression }],
});

describe("semantic calls", () => {
  it("are found with their objects", () => {
    const r = parseExpression(
      '{ "a": $toSemantic($trigger, "oracle-ebs", "HZ_CUST_ACCOUNTS"), "b": $translate($trigger.x, "netsuite", "customer", "sap-s4hana", "A_Customer") }',
    );
    expect(r.semantics).toEqual([
      { fn: "toSemantic", objects: [{ system: "oracle-ebs", object: "HZ_CUST_ACCOUNTS" }] },
      {
        fn: "translate",
        objects: [
          { system: "netsuite", object: "customer" },
          { system: "sap-s4hana", object: "A_Customer" },
        ],
      },
    ]);
    expect(r.references).toEqual(["trigger"]);
  });

  it("must name objects literally", () => {
    const r = validateFlow(flow('$fromSemantic($trigger, $trigger.system, "customer")'));
    expect(r.errors.map((e) => e.code)).toEqual(["semantic_call"]);
    expect(r.errors[0]?.message).toContain("literal text");
    expect(validateFlow(flow('$toSemantic($trigger, "netsuite")')).errors[0]?.code).toBe("semantic_call");
  });

  it("are checked against bound objects", () => {
    const semanticObjects = { "netsuite/customer": "Customer", "netsuite/vendor": "Supplier" };
    expect(validateFlow(flow('$toSemantic($trigger, "netsuite", "customer")'), { semanticObjects }).ok).toBe(true);
    const unknown = validateFlow(flow('$toSemantic($trigger, "netsuite", "invoice")'), { semanticObjects });
    expect(unknown.errors.map((e) => e.code)).toEqual(["unknown_semantic_object"]);
    const mismatch = validateFlow(flow('$translate($trigger, "netsuite", "customer", "netsuite", "vendor")'), {
      semanticObjects,
    });
    expect(mismatch.errors[0]?.message).toContain("same entity");
  });
});
