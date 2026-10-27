import { randomUUID } from "node:crypto";
import { checkProposal, describeSample, type SemanticPlan } from "@oicr/semantic";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import type { Actor } from "./repo/access.js";
import { ConflictError } from "./repo/access.js";
import {
  activateIntegration,
  createIntegration,
  deactivateIntegration,
  getIntegration,
  InvalidStateError,
  loadPlan,
  saveDefinition,
} from "./repo/integrations.js";
import { createProject } from "./repo/projects.js";
import {
  addAttribute,
  decideProposal,
  deleteEntity,
  loadSemanticGraph,
  recordProposal,
  resetBinding,
  saveObject,
  semanticDrift,
  setBinding,
} from "./repo/semantic.js";
import { memberships, orgs, users } from "./schema/auth.js";
import { semanticBindings } from "./schema/semantic.js";
import { asTenant } from "./tenancy.js";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;

describe.skipIf(!url)("semantic catalog", () => {
  let a: Actor;
  let b: Actor;
  let projectId: string;

  const tenant = async (name: string): Promise<Actor> => {
    const [u] = await db!
      .insert(users)
      .values({ name, email: `${name}-${randomUUID()}@example.com` })
      .returning();
    const [o] = await db!
      .insert(orgs)
      .values({ name, slug: `${name}-${randomUUID()}` })
      .returning();
    await db!.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
    return { userId: u!.id, orgId: o!.id, role: "admin" };
  };

  beforeAll(async () => {
    await runMigrations(url);
    a = await tenant("sem-a");
    b = await tenant("sem-b");
    projectId = (await createProject(db!, a, { name: "Customers" })).id;
  });
  afterAll(() => db?.$client.end());

  it("keeps each workspace's bindings to itself", async () => {
    await addAttribute(db!, a, "Customer", { name: "loyaltyTier", type: "string", label: "Loyalty tier" });
    await setBinding(db!, a, {
      system: "netsuite",
      object: "customer",
      field: "custentity_tier",
      attribute: "loyaltyTier",
    });
    const ga = await loadSemanticGraph(db!, a.orgId);
    const gb = await loadSemanticGraph(db!, b.orgId);
    expect(ga.object("netsuite", "customer")?.fields.some((f) => f.field === "custentity_tier")).toBe(true);
    expect(gb.object("netsuite", "customer")?.fields.some((f) => f.field === "custentity_tier")).toBe(false);
    expect(gb.attribute("Customer", "loyaltyTier")).toBeUndefined();
    const seenByB = await asTenant(db!, b.orgId, (tx) => tx.select().from(semanticBindings));
    expect(seenByB).toEqual([]);
  });

  it("checks bindings before saving them", async () => {
    await expect(
      setBinding(db!, a, { system: "netsuite", object: "customer", field: "x", attribute: "colour" }),
    ).rejects.toThrow(InvalidStateError);
    await expect(
      setBinding(db!, a, { system: "netsuite", object: "customer", field: "y", attribute: "loyaltyTier" }),
    ).rejects.toThrow(ConflictError);
    await expect(
      setBinding(db!, a, { system: "netsuite", object: "customer", field: "z", attribute: "name", read: "$value (" }),
    ).rejects.toThrow(/JSONata/);
    await expect(deleteEntity(db!, a, "Customer")).rejects.toThrow(/unbind/);
  });

  it("applies confident AI proposals and queues the rest for review", async () => {
    await saveObject(db!, a, { system: "acme-crm", object: "Accounts", entity: "Customer" });
    await setBinding(db!, a, { system: "acme-crm", object: "Accounts", field: "Title", attribute: "name" });
    const sample = describeSample(
      '[{"AcctNo":"A1","Title":"Acme","Name2":"Acme Inc","Mail":"x@acme.test","Tier":"gold"}]',
    );
    const checked = checkProposal(await loadSemanticGraph(db!, a.orgId), sample, {
      entity: "Customer",
      entityConfidence: 0.95,
      bindings: [
        { field: "AcctNo", attribute: "number", confidence: 0.97, evidence: "account number" },
        { field: "Name2", attribute: "name", confidence: 0.92, evidence: "name" },
        { field: "Mail", attribute: "email", confidence: 0.7, evidence: "looks like email" },
        { field: "Tier", attribute: "loyaltyTier", confidence: 0.95, evidence: "tier" },
      ],
      unmapped: [],
    });
    if (!checked.ok) throw new Error(checked.error);
    const p = await recordProposal(db!, a, {
      system: "acme-crm",
      object: "Accounts",
      proposal: checked.proposal,
      fields: sample.fields.map((f) => ({ field: f.field, type: f.type })),
      model: "test",
      autoApproveAt: 0.9,
    });
    const decision = Object.fromEntries(p.items.map((i) => [i.field, i.decision]));
    expect(decision).toEqual({ AcctNo: "auto_approved", Name2: "pending", Mail: "pending", Tier: "auto_approved" });
    expect(p.items.find((i) => i.field === "Name2")?.conflict).toBe("name is bound to Title now.");
    expect(p.status).toBe("open");

    let o = (await loadSemanticGraph(db!, a.orgId)).object("acme-crm", "Accounts")!;
    expect(o.fields.map((f) => f.field).sort()).toEqual(["AcctNo", "Tier", "Title"]);

    const done = await decideProposal(db!, a, p.id, [
      { field: "Name2", decision: "approve" },
      { field: "Mail", decision: "reject" },
    ]);
    expect(done.status).toBe("closed");
    o = (await loadSemanticGraph(db!, a.orgId)).object("acme-crm", "Accounts")!;
    // The approval moved "name" from Title to Name2.
    expect(Object.fromEntries(o.fields.map((f) => [f.field, f.attribute]))).toEqual({
      AcctNo: "number",
      Name2: "name",
      Tier: "loyaltyTier",
    });
  });

  it("compiles bindings into the plan at activation and reports drift", async () => {
    const integration = await createIntegration(db!, a, { projectId, name: "Customer sync", style: "application" });
    const definition = {
      schemaVersion: 1,
      style: "application",
      trigger: { id: "t", type: "http", method: "POST", sync: true },
      steps: [
        {
          id: "m",
          type: "map",
          expression: '$translate($trigger, "oracle-ebs", "HZ_CUST_ACCOUNTS", "netsuite", "customer")',
        },
        { id: "r", type: "return", body: "$m" },
      ],
    };
    const bad = await saveDefinition(
      db!,
      a,
      integration.id,
      {
        ...definition,
        steps: [
          { ...definition.steps[0], expression: '$toSemantic($trigger, "netsuite", "widget")' },
          definition.steps[1],
        ],
      },
      integration.definitionHash,
    );
    expect(bad.errors.map((e) => e.code)).toEqual(["unknown_semantic_object"]);
    const saved = await saveDefinition(db!, a, integration.id, definition, bad.integration.definitionHash);
    expect(saved.errors).toEqual([]);

    const active = await activateIntegration(db!, a, integration.id);
    const plan = await loadPlan(db!, a.orgId, active.activePlanId!);
    const semantics = plan!.semantics as SemanticPlan;
    expect(Object.keys(semantics.objects)).toEqual(["netsuite/customer", "oracle-ebs/HZ_CUST_ACCOUNTS"]);
    expect(semantics.objects["netsuite/customer"]?.fields.some((f) => f.path[0] === "custentity_tier")).toBe(true);
    expect(plan!.semanticHash).toBe(semantics.hash);
    expect(await semanticDrift(db!, a, active.activePlanId)).toEqual([]);

    await setBinding(db!, a, { system: "netsuite", object: "customer", field: "altName", attribute: "alternateName" });
    expect(await semanticDrift(db!, a, active.activePlanId)).toEqual(["netsuite/customer"]);
    // The running plan is unchanged until the integration is activated again.
    expect((await loadPlan(db!, a.orgId, active.activePlanId!))!.semanticHash).toBe(semantics.hash);

    await deactivateIntegration(db!, a, integration.id);
    const again = await activateIntegration(db!, a, integration.id);
    expect(again.activePlanId).not.toBe(active.activePlanId);
    expect(await semanticDrift(db!, a, again.activePlanId)).toEqual([]);

    // Reverting the binding makes the first plan current again, and it is reused.
    await resetBinding(db!, a, "netsuite", "customer", "altName");
    await deactivateIntegration(db!, a, integration.id);
    expect((await activateIntegration(db!, a, integration.id)).activePlanId).toBe(active.activePlanId);
  });

  it("refuses activation when a bound object disappeared after saving", async () => {
    await saveObject(db!, a, { system: "acme-erp", object: "CUST", entity: "Customer" });
    await setBinding(db!, a, { system: "acme-erp", object: "CUST", field: "NO", attribute: "number" });
    const integration = await createIntegration(db!, a, {
      projectId,
      name: "Acme",
      style: "application",
      definition: {
        schemaVersion: 1,
        style: "application",
        trigger: { id: "t", type: "http", method: "POST", sync: false },
        steps: [{ id: "m", type: "map", expression: '$toSemantic($trigger, "acme-erp", "CUST")' }],
      },
    });
    expect(integration.status).toBe("configured");
    await resetBinding(db!, a, "acme-erp", "CUST", "NO");
    await expect(activateIntegration(db!, a, integration.id)).rejects.toThrow(/no semantic bindings/);
    expect((await getIntegration(db!, a, integration.id)).status).toBe("draft");
    const rows = await asTenant(db!, a.orgId, (tx) =>
      tx.select().from(semanticBindings).where(eq(semanticBindings.object, "CUST")),
    );
    expect(rows).toEqual([]);
  });
});
