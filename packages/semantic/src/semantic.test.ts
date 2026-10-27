import { FlowDoc, parseExpression } from "@oicr/flow-schema";
import { describe, expect, it } from "vitest";
import {
  bindingPrompt,
  checkProposal,
  compileObjects,
  compileSemantics,
  describeSample,
  PLATFORM_OBJECTS,
  SampleError,
  SemanticGraph,
  semanticFunctions,
  staleObjects,
  type TenantLayer,
  toDialect,
  toStandard,
} from "./index.js";

const flow = (expression: string) =>
  FlowDoc.parse({
    schemaVersion: 1,
    style: "application",
    trigger: { id: "t", type: "http", method: "POST", sync: true },
    steps: [
      { id: "m", type: "map", expression },
      { id: "r", type: "return", body: "$m" },
    ],
  });

const layer = (over: Partial<TenantLayer>): TenantLayer => ({ entities: [], objects: [], bindings: [], ...over });

describe("platform bindings", () => {
  it("bind only attributes that exist, once each, with valid transforms", () => {
    const g = new SemanticGraph();
    expect(g.problems).toEqual([]);
    for (const seed of PLATFORM_OBJECTS) {
      const o = g.object(seed.system, seed.object)!;
      expect(o.fields.length, `${seed.system}/${seed.object}`).toBe(seed.fields.length);
      for (const f of seed.fields) {
        expect(g.attribute(seed.entity, f.attribute), `${seed.object}.${f.field}`).toBeDefined();
        for (const t of [f.read, f.write]) if (t) expect(parseExpression(t).ok, t).toBe(true);
      }
    }
    expect(new Set(g.objects().map((o) => o.system))).toEqual(
      new Set(["oracle-fusion", "oracle-ebs", "netsuite", "sap-s4hana"]),
    );
    // Every platform entity is bound in at least two systems.
    for (const e of g.entities()) expect(g.objects({ entity: e.name }).length, e.name).toBeGreaterThanOrEqual(2);
  });
});

describe("SemanticGraph", () => {
  it("lets the workspace extend, rebind and unbind", () => {
    const g = new SemanticGraph(
      layer({
        entities: [
          {
            name: "Customer",
            label: "Customer",
            description: "",
            attributes: [{ name: "loyaltyTier", type: "string", label: "Loyalty tier", description: "" }],
          },
          {
            name: "Shipment",
            label: "Shipment",
            description: "A delivery.",
            attributes: [
              { name: "trackingNumber", type: "string", label: "Tracking", description: "", identifier: true },
            ],
          },
        ],
        objects: [{ system: "shipstation", object: "shipments", entity: "Shipment" }],
        bindings: [
          { system: "netsuite", object: "customer", field: "custentity_tier", attribute: "loyaltyTier" },
          { system: "netsuite", object: "customer", field: "altName", attribute: "name" },
          { system: "netsuite", object: "customer", field: "phone", attribute: null },
          { system: "shipstation", object: "shipments", field: "trackingNumber", attribute: "trackingNumber" },
          { system: "netsuite", object: "customer", field: "x", attribute: "nope" },
        ],
      }),
    );
    expect(g.entity("Customer")?.extended).toEqual(["loyaltyTier"]);
    const c = g.object("netsuite", "customer")!;
    const byField = Object.fromEntries(c.fields.map((f) => [f.field, f]));
    expect(byField.custentity_tier?.origin).toBe("tenant");
    expect(byField.altName?.attribute).toBe("name");
    expect(byField.companyName).toBeUndefined(); // replaced: one field per attribute
    expect(byField.phone).toBeUndefined();
    expect(g.system("shipstation")?.origin).toBe("tenant");
    expect(g.objectIndex()["shipstation/shipments"]).toBe("Shipment");
    expect(g.problems.map((p) => p.message)).toEqual(['Customer has no attribute "nope", so x is ignored.']);
  });

  it("drops platform fields when the workspace binds an object to another entity", () => {
    const g = new SemanticGraph(
      layer({ objects: [{ system: "oracle-ebs", object: "HZ_CUST_ACCOUNTS", entity: "Supplier" }] }),
    );
    expect(g.object("oracle-ebs", "HZ_CUST_ACCOUNTS")?.fields).toEqual([]);
    expect(g.objectIndex()["oracle-ebs/HZ_CUST_ACCOUNTS"]).toBeUndefined();
  });
});

describe("compileSemantics", () => {
  it("pins the objects a flow uses and nothing else", () => {
    const g = new SemanticGraph();
    const r = compileSemantics(
      flow('$translate($trigger, "oracle-ebs", "HZ_CUST_ACCOUNTS", "netsuite", "customer")'),
      g,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || !r.plan) throw new Error("no plan");
    expect(Object.keys(r.plan.objects)).toEqual(["netsuite/customer", "oracle-ebs/HZ_CUST_ACCOUNTS"]);
    expect(r.plan.objects["oracle-ebs/HZ_CUST_ACCOUNTS"]?.dialect.booleans).toBe("YN");
    expect(compileSemantics(flow("$trigger"), g)).toEqual({ ok: true, plan: null });
  });

  it("refuses unknown objects and entity mismatches", () => {
    const g = new SemanticGraph();
    const r = compileSemantics(flow('$translate($trigger, "netsuite", "customer", "netsuite", "vendor")'), g);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({ stepId: "m", path: ["steps", 0, "expression"] });
    expect(compileSemantics(flow('$toSemantic($trigger, "netsuite", "widget")'), g).ok).toBe(false);
  });

  it("detects plans whose bindings changed", () => {
    const plan = compileObjects(new SemanticGraph(), ["netsuite/customer", "netsuite/vendor"]);
    const changed = new SemanticGraph(
      layer({ bindings: [{ system: "netsuite", object: "customer", field: "altName", attribute: "alternateName" }] }),
    );
    expect(staleObjects(plan, new SemanticGraph())).toEqual([]);
    expect(staleObjects(plan, changed)).toEqual(["netsuite/customer"]);
    expect(compileObjects(changed, ["netsuite/customer"]).hash).not.toBe(
      compileObjects(new SemanticGraph(), ["netsuite/customer"]).hash,
    );
  });
});

describe("semantic functions", () => {
  const plan = compileObjects(new SemanticGraph(), [
    "oracle-ebs/HZ_CUST_ACCOUNTS",
    "oracle-ebs/AP_SUPPLIERS",
    "netsuite/customer",
    "netsuite/salesOrder",
    "sap-s4hana/A_Customer",
    "sap-s4hana/A_SalesOrder",
  ]);
  const fns = semanticFunctions(plan);

  it("reads technical records into the catalog's standard form", async () => {
    const out = await fns.toSemantic(
      {
        ACCOUNT_NUMBER: 1001,
        ACCOUNT_NAME: "Acme",
        STATUS: "A",
        CREATION_DATE: "2026-01-05 09:30:00",
        CUST_ACCOUNT_ID: 99,
      },
      "oracle-ebs",
      "HZ_CUST_ACCOUNTS",
    );
    expect(out).toEqual({ number: "1001", name: "Acme", active: true, createdAt: "2026-01-05T09:30:00" });
    expect(await fns.toSemantic({ SEGMENT1: "S1", ENABLED_FLAG: "N" }, "oracle-ebs", "AP_SUPPLIERS")).toEqual({
      number: "S1",
      active: false,
    });
    expect(
      await fns.toSemantic(
        { SalesOrder: "42", SalesOrderDate: "/Date(1767225600000)/", TotalNetAmount: "12.50" },
        "sap-s4hana",
        "A_SalesOrder",
      ),
    ).toEqual({ number: "42", orderDate: "2026-01-01", totalAmount: 12.5 });
    expect(
      await fns.toSemantic(
        { tranId: "SO7", status: { id: "B", refName: "Pending Fulfillment" } },
        "netsuite",
        "salesOrder",
      ),
    ).toEqual({ number: "SO7", status: "Pending Fulfillment" });
  });

  it("writes entities in each system's dialect, skipping read-only fields", async () => {
    expect(
      await fns.fromSemantic(
        { number: "S1", active: true, updatedAt: "2026-01-01T00:00:00Z" },
        "oracle-ebs",
        "AP_SUPPLIERS",
      ),
    ).toEqual({ SEGMENT1: "S1", ENABLED_FLAG: "Y", LAST_UPDATE_DATE: "2026-01-01T00:00:00Z" });
    expect(
      await fns.fromSemantic({ number: "42", orderDate: "2026-01-01", status: "C" }, "sap-s4hana", "A_SalesOrder"),
    ).toEqual({ SalesOrder: "42", SalesOrderDate: "/Date(1767225600000)/" });
    expect(await fns.fromSemantic({ number: "C1", status: "x" }, "netsuite", "salesOrder")).toEqual({ tranId: "C1" });
  });

  it("translates lists system to system through the catalog", async () => {
    const out = await fns.translate(
      [
        { ACCOUNT_NUMBER: "1001", ACCOUNT_NAME: "Acme", STATUS: "I" },
        { ACCOUNT_NUMBER: "1002", ACCOUNT_NAME: "Globex", STATUS: "A" },
      ],
      "oracle-ebs",
      "HZ_CUST_ACCOUNTS",
      "netsuite",
      "customer",
    );
    expect(out).toEqual([
      { entityId: "1001", companyName: "Acme", isInactive: true },
      { entityId: "1002", companyName: "Globex", isInactive: false },
    ]);
    expect(
      await fns.translate(
        { Customer: "17100001", CustomerName: "Inlandkunde", DeletionIndicator: false },
        "sap-s4hana",
        "A_Customer",
        "oracle-ebs",
        "HZ_CUST_ACCOUNTS",
      ),
    ).toEqual({ ACCOUNT_NUMBER: "17100001", ACCOUNT_NAME: "Inlandkunde", STATUS: "A" });
    expect(await fns.toSemantic(null, "netsuite", "customer")).toBeUndefined();
  });

  it("explains objects missing from the plan and bad input", async () => {
    await expect(fns.toSemantic({}, "netsuite", "vendor")).rejects.toThrow(/not in this integration's execution plan/);
    await expect(fns.toSemantic("x", "netsuite", "customer")).rejects.toThrow(/expects customer records/);
    await expect(fns.translate({}, "netsuite", "customer", "oracle-ebs", "AP_SUPPLIERS")).rejects.toThrow(
      /same entity/,
    );
    await expect(semanticFunctions(null).toSemantic({}, "netsuite", "customer")).rejects.toThrow(/Activate/);
  });

  it("normalises and renders values", () => {
    expect(toStandard("X", "boolean")).toBe(true);
    expect(toStandard("", "boolean")).toBe(false);
    expect(toStandard("abc", "number")).toBe("abc");
    expect(toStandard("/Date(1767225600000+0000)/", "datetime")).toBe("2026-01-01T00:00:00.000Z");
    expect(toStandard("2026-01-05T10:00:00Z", "date")).toBe("2026-01-05");
    expect(toDialect(false, "boolean", { booleans: "YN", dates: "iso" })).toBe("N");
  });
});

describe("binding discovery", () => {
  it("reads JSON records, API envelopes, CSV and column lists", () => {
    const odata = describeSample(
      JSON.stringify({ d: { results: [{ __metadata: { uri: "x" }, Customer: "1", Address: { City: "Berlin" } }] } }),
    );
    expect(odata.fields.map((f) => f.field)).toEqual(["Customer", "Address.City"]);
    expect(odata.records).toBe(1);
    const items = describeSample(JSON.stringify({ items: [{ a: 1 }, { a: 2 }, { a: 2 }, { a: null }] }));
    expect(items.fields).toEqual([{ field: "a", type: "number", examples: ["1", "2"] }]);
    const hidden = describeSample('[{"email":"a@b.c"}]', { includeValues: false });
    expect(hidden.fields[0]?.examples).toEqual([]);
    const csv = describeSample('ID,NAME\n1,"Acme, Inc."\n2,Globex');
    expect(csv.fields).toEqual([
      { field: "ID", type: "text", examples: ["1", "2"] },
      { field: "NAME", type: "text", examples: ["Acme, Inc.", "Globex"] },
    ]);
    const cols = describeSample(
      "ACCOUNT_NUMBER VARCHAR2(30) Account number\nSTATUS - A active, I inactive\nPARTY_ID NUMBER",
    );
    expect(cols.fields).toEqual([
      { field: "ACCOUNT_NUMBER", type: "VARCHAR2(30)", examples: [], description: "Account number" },
      { field: "STATUS", type: "unknown", examples: [], description: "A active, I inactive" },
      { field: "PARTY_ID", type: "NUMBER", examples: [] },
    ]);
    expect(() => describeSample("{ nope")).toThrow(SampleError);
  });

  it("checks proposals against the catalog and the sample", () => {
    const g = new SemanticGraph();
    const sample = describeSample('[{"CUSTNO":"C1","NAME1":"Acme","NAME2":"Acme Corp","FLAG":"A","ZZ":1}]');
    const r = checkProposal(g, sample, {
      entity: "Customer",
      entityConfidence: 0.9,
      bindings: [
        { field: "CUSTNO", attribute: "number", confidence: 0.97, evidence: "customer number" },
        { field: "NAME1", attribute: "name", confidence: 0.8, evidence: "name" },
        { field: "NAME2", attribute: "name", confidence: 0.85, evidence: "full name" },
        {
          field: "FLAG",
          attribute: "active",
          confidence: 0.6,
          evidence: "A/I",
          read: '$value = "A"',
          write: "$value ? (",
        },
        { field: "GONE", attribute: "email", confidence: 0.5, evidence: "?" },
        { field: "ZZ", attribute: "colour", confidence: 0.5, evidence: "?" },
      ],
      unmapped: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.bindings.map((b) => `${b.field}>${b.attribute}`)).toEqual(["CUSTNO>number", "NAME2>name"]);
    expect(r.proposal.dropped.map((d) => d.field)).toEqual(["NAME1", "FLAG", "GONE", "ZZ"]);
    expect(r.proposal.unmapped.map((u) => u.field)).toEqual(["NAME1", "FLAG", "ZZ"]);
    expect(
      checkProposal(g, sample, { entity: "Widget", entityConfidence: 1, bindings: [], unmapped: [] }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("grounds the prompt in the catalog and the system's conventions", () => {
    const g = new SemanticGraph();
    const p = bindingPrompt(g, {
      system: "oracle-ebs",
      object: "HZ_PARTIES",
      sample: describeSample("PARTY_NUMBER VARCHAR2(30)\nPARTY_NAME VARCHAR2(360)"),
    });
    expect(p.system).toContain("### Customer");
    expect(p.system).toContain("Also called: account number");
    expect(p.user).toContain("Oracle E-Business Suite (oracle-ebs)");
    expect(p.user).toContain("HZ_CUST_ACCOUNTS → Customer");
    expect(p.user).toContain("- PARTY_NAME: VARCHAR2(360)");
  });
});
