import { randomUUID } from "node:crypto";
import { type Actor, type AiSession, createDb, loadSemanticGraph, memberships, orgs, users } from "@oicr/db";
import { runMigrations } from "@oicr/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverBindings, ProposalError, runTool, ScriptedModel, type ToolContext } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;

const submit = (id: string, input: unknown) => [{ type: "tool_use", id, name: "submit_bindings", input }];

const SAMPLE = JSON.stringify({
  items: [
    { CustNo: "C-100", Title: "Acme GmbH", Mail: "ap@acme.test", Blocked: "N", Region: "EMEA" },
    { CustNo: "C-101", Title: "Globex", Mail: "", Blocked: "Y", Region: "AMER" },
  ],
});

describe.skipIf(!url)("AI binding discovery (Postgres + scripted model)", () => {
  let actor: Actor;

  beforeAll(async () => {
    await runMigrations(url);
    const [u] = await db!
      .insert(users)
      .values({ name: "S", email: `sem-${randomUUID()}@example.com` })
      .returning();
    const [o] = await db!
      .insert(orgs)
      .values({ name: "Sem", slug: `sem-${randomUUID()}` })
      .returning();
    await db!.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
    actor = { userId: u!.id, orgId: o!.id, role: "admin" };
  });
  afterAll(() => db?.$client.end());

  it("checks the model's proposal, lets it correct itself, and applies confident bindings", async () => {
    const model = new ScriptedModel([
      submit("t1", {
        entity: "Customer",
        entityConfidence: 0.95,
        bindings: [{ field: "CustNo", attribute: "customerNo", confidence: 0.9, evidence: "name" }],
        unmapped: [],
      }),
      submit("t2", {
        entity: "Customer",
        entityConfidence: 0.95,
        reasoning: "Customer master data: number, name, email, blocked flag.",
        bindings: [
          { field: "CustNo", attribute: "number", confidence: 0.97, evidence: "CustNo values look like C-100" },
          { field: "Title", attribute: "name", confidence: 0.93, evidence: "company names" },
          { field: "Mail", attribute: "email", confidence: 0.95, evidence: "email addresses" },
          {
            field: "Blocked",
            attribute: "active",
            confidence: 0.8,
            evidence: "Y/N blocked flag, inverted",
            read: "$not($value)",
            write: "$not($value)",
          },
        ],
        unmapped: [{ field: "Region", reason: "No region attribute on Customer." }],
      }),
    ]);
    const p = await discoverBindings(db!, actor, model, {
      system: "acme-crm",
      object: "Customers",
      sample: SAMPLE,
      includeValues: false,
    });
    // The first answer was refused with the reason; values were withheld from the prompt.
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain('Customer has no attribute \\"customerNo\\"');
    expect(String(model.requests[0]!.messages[0]!.content)).not.toContain("Acme GmbH");
    expect(String(model.requests[0]!.messages[0]!.content)).toContain("- Title: string");

    expect(p).toMatchObject({ entity: "Customer", model: "scripted", status: "open" });
    expect(Object.fromEntries(p.items.map((i) => [i.field, i.decision]))).toEqual({
      CustNo: "auto_approved",
      Title: "auto_approved",
      Mail: "auto_approved",
      Blocked: "pending",
    });
    expect(p.unmapped).toEqual([{ field: "Region", reason: "No region attribute on Customer." }]);
    expect(JSON.stringify(p)).not.toContain("Acme GmbH");

    const o = (await loadSemanticGraph(db!, actor.orgId)).object("acme-crm", "Customers")!;
    expect(o.entity).toBe("Customer");
    expect(o.fields.map((f) => `${f.field}>${f.attribute}`).sort()).toEqual([
      "CustNo>number",
      "Mail>email",
      "Title>name",
    ]);
    expect(o.fields.find((f) => f.field === "CustNo")).toMatchObject({ origin: "tenant", confidence: 0.97 });
  });

  it("gives up after one correction round", async () => {
    const bad = { entity: "Widget", entityConfidence: 1, bindings: [], unmapped: [] };
    const model = new ScriptedModel([submit("a", bad), submit("b", bad)]);
    await expect(
      discoverBindings(db!, actor, model, { system: "acme-crm", object: "Widgets", sample: SAMPLE }),
    ).rejects.toThrow(ProposalError);
  });

  it("lets the builder read the catalog and try semantic expressions", async () => {
    const ctx = { db: db!, actor, session: {} as AiSession, failedProposals: 0, emit: () => {} } satisfies ToolContext;
    const overview = JSON.parse((await runTool("semantic_catalog", { entity: "", system: "" }, ctx)).content);
    expect(overview.systems.find((s: { id: string }) => s.id === "acme-crm").objects).toEqual(["Customers → Customer"]);
    const customer = JSON.parse(
      (await runTool("semantic_catalog", { entity: "Customer", system: "netsuite" }, ctx)).content,
    );
    expect(customer.boundObjects[0]).toMatchObject({ object: "customer", fields: { entityId: "number" } });

    const tried = await runTool(
      "test_expression",
      {
        expression: '$translate($trigger.items, "acme-crm", "Customers", "oracle-ebs", "HZ_CUST_ACCOUNTS")',
        bindings_json: SAMPLE.replace('{"items"', '{"trigger":{"items"').concat("}"),
      },
      ctx,
    );
    expect(JSON.parse(tried.content).result).toEqual([
      { ACCOUNT_NUMBER: "C-100", ACCOUNT_NAME: "Acme GmbH" },
      { ACCOUNT_NUMBER: "C-101", ACCOUNT_NAME: "Globex" },
    ]);
  });
});
