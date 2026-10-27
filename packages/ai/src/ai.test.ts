import { randomBytes, randomUUID } from "node:crypto";
import {
  type Actor,
  acceptAiChange,
  activateIntegration,
  aiMessages,
  asTenant,
  claimAiSession,
  createAiSession,
  createConnection,
  createDb,
  createProject,
  deactivateIntegration,
  getAiSession,
  getIntegration,
  memberships,
  orgs,
  rejectAiChange,
  saveDefinition,
  users,
} from "@oicr/db";
import { runMigrations } from "@oicr/db/migrate";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AiEvent, runTurn, ScriptedModel, systemPrompt, TOOLS } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;

const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

const goodFlow = {
  schemaVersion: 1,
  style: "scheduled",
  trigger: { id: "trigger", type: "schedule" },
  steps: [
    { id: "fetch", type: "invoke", label: "Read orders", connection: "orders_api", operation: "GET /orders" },
    {
      id: "each",
      type: "forEach",
      over: "$fetch.body.orders",
      as: "order",
      steps: [
        {
          id: "send",
          type: "invoke",
          label: "Send",
          connection: "shop_api",
          operation: "POST /orders",
          request: '{ "body": $order }',
        },
      ],
    },
  ],
};

describe("tool definitions", () => {
  it("are strict where they can be, and propose_flow streams its large input", () => {
    for (const t of TOOLS) {
      if (t.strict)
        expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties, t.name).toBe(false);
    }
    expect(TOOLS.find((t) => t.name === "propose_flow")?.eager_input_streaming).toBe(true);
    expect(TOOLS.map((t) => t.name)).not.toContain("activate_integration");
  });

  it("keep the system prompt byte-identical and cache-marked", () => {
    const a = JSON.stringify(systemPrompt());
    const b = JSON.stringify(systemPrompt());
    expect(a).toBe(b);
    expect(systemPrompt()[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps in the cached prefix
    expect(systemPrompt()[0]?.text).toContain('"const":"forEach"');
  });
});

describe.skipIf(!url)("AI builder loop (Postgres + scripted model)", () => {
  let actor: Actor;
  let projectId: string;

  beforeAll(async () => {
    process.env.SECRETS_KEY = randomBytes(32).toString("base64");
    await runMigrations(url);
    const [u] = await db!
      .insert(users)
      .values({ name: "T", email: `ai-${randomUUID()}@example.com` })
      .returning();
    const [o] = await db!
      .insert(orgs)
      .values({ name: "AI", slug: `ai-${randomUUID()}` })
      .returning();
    await db!.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
    actor = { userId: u!.id, orgId: o!.id, role: "admin" };
    projectId = (await createProject(db!, actor, { name: `AI ${Date.now()}` })).id;
    await createConnection(db!, actor, {
      name: "Orders API",
      identifier: "orders_api",
      adapter: "rest",
      properties: { baseUrl: "https://orders.example.com" },
      authType: "api_key",
      secret: { apiKey: "super-secret-key-123" },
    });
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  const turn = async (sessionId: string, model: ScriptedModel, input: string) => {
    const events: AiEvent[] = [];
    const status = await runTurn({ db: db!, actor, sessionId, text: input, model, emit: (e) => events.push(e) });
    return { status, events };
  };

  it("asks a question, drafts a connection, repairs an invalid proposal, then proposes", async () => {
    const session = await createAiSession(db!, actor, { projectId, title: "orders to shop" });
    const model = new ScriptedModel([
      // turn 1: look around and ask in the same message
      [
        text("Let me check your connections."),
        use("t1", "list_connections", {}),
        use("t2", "ask_user", { question: "How often?", choices: ["Every 15 minutes", "Hourly"] }),
      ],
      // after the answer: draft the missing connection, then propose with a typo
      [
        use("t3", "request_connection", {
          name: "Shop API",
          identifier: "shop_api",
          base_url: "https://shop.example.com",
          auth_type: "bearer",
          reason: "To create orders",
        }),
      ],
      [
        use("t4", "propose_flow", {
          name: "Orders to shop",
          summary: "x",
          schedule: { kind: "interval", expression: "PT15M", timezone: "UTC" },
          flow: { ...goodFlow, steps: [{ ...goodFlow.steps[0], connection: "orders_apii" }, goodFlow.steps[1]] },
        }),
      ],
      [
        use("t5", "propose_flow", {
          name: "Orders to shop",
          summary: "Every 15 minutes, sends new orders to the shop.",
          schedule: { kind: "interval", expression: "PT15M", timezone: "UTC" },
          flow: goodFlow,
        }),
      ],
      [text("Done. Add the Shop API token, test it, then accept and activate.")],
    ]);

    const first = await turn(session.id, model, "Every so often send new orders from the orders API to our shop");
    expect(first.status).toBe("waiting");
    expect(first.events).toContainEqual({
      type: "question",
      question: "How often?",
      choices: ["Every 15 minutes", "Hourly"],
    });
    // credentials never reach the model
    const listResult = JSON.stringify(model.requests);
    expect(listResult).not.toContain("super-secret-key-123");

    const waiting = await getAiSession(db!, actor, session.id);
    expect(waiting.session.status).toBe("waiting");
    expect(waiting.session.pending?.toolUseId).toBe("t2");

    const second = await turn(session.id, model, "Every 15 minutes");
    expect(second.status).toBe("idle");
    expect(second.events.filter((e) => e.type === "connection")).toHaveLength(1);
    expect(second.events.filter((e) => e.type === "proposal")).toHaveLength(1);
    const toolErrors = second.events.filter((e) => e.type === "tool" && e.status === "error");
    expect(toolErrors).toHaveLength(1);

    // The answer went back together with the other tool result of that turn.
    const rows = await asTenant(db!, actor.orgId, (db) =>
      db.select().from(aiMessages).where(eq(aiMessages.sessionId, session.id)).orderBy(asc(aiMessages.seq)),
    );
    const answer = rows[2]!.content as { type: string; tool_use_id: string; content: string }[];
    expect(answer.map((b) => b.tool_use_id).sort()).toEqual(["t1", "t2"]);
    expect(answer.find((b) => b.tool_use_id === "t2")?.content).toBe("Every 15 minutes");
    // strictly alternating, starting with the user
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // the model saw the validation errors with paths
    const repair = JSON.stringify(model.requests[3]?.messages.at(-1));
    expect(repair).toContain('Connection \\"orders_apii\\" does not exist');

    const { changes } = await getAiSession(db!, actor, session.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ status: "proposed", name: "Orders to shop", integrationId: null });
    expect((changes[0]!.diff as { added: unknown[] }).added).toHaveLength(3);

    // A person accepts: a new integration with its schedule
    const { integrationId } = await acceptAiChange(db!, actor, changes[0]!.id);
    const integration = await getIntegration(db!, actor, integrationId);
    expect(integration.status).toBe("configured");
    expect(integration.schedule?.expression).toBe("PT15M");
    expect((await getAiSession(db!, actor, session.id)).session.integrationId).toBe(integrationId);
    await expect(acceptAiChange(db!, actor, changes[0]!.id)).rejects.toThrow(/already accepted/);
  });

  it("edits an existing integration by instruction and refuses stale proposals", async () => {
    const session = await createAiSession(db!, actor, { projectId, title: "first" });
    const create = new ScriptedModel([
      [
        use("a1", "propose_flow", {
          name: "Edit me",
          summary: "s",
          schedule: { kind: "interval", expression: "PT1H", timezone: "UTC" },
          flow: goodFlow,
        }),
      ],
      [text("ok")],
    ]);
    await turn(session.id, create, "build it");
    const { changes } = await getAiSession(db!, actor, session.id);
    const { integrationId } = await acceptAiChange(db!, actor, changes[0]!.id);

    const edited = structuredClone(goodFlow) as any;
    edited.steps[1].steps[0].retry = { attempts: 3, backoffSeconds: 5 };
    const edit = new ScriptedModel([
      [use("b1", "get_flow", {})],
      [use("b2", "propose_flow", { name: "Edit me", summary: "Added retries to Send.", schedule: null, flow: edited })],
      [text("Added 3 retries to the send step.")],
    ]);
    const r = await turn(session.id, edit, "retry the send step 3 times");
    expect(r.status).toBe("idle");
    expect(JSON.stringify(edit.requests[1]?.messages.at(-1))).toContain("Edit me"); // get_flow returned the integration
    const after = await getAiSession(db!, actor, session.id);
    const change = after.changes.at(-1)!;
    expect(change.integrationId).toBe(integrationId);
    expect((change.diff as { changed: { id: string }[] }).changed.map((s) => s.id)).toEqual(["send"]);

    // Someone edits the integration meanwhile: the proposal is refused as stale.
    const current = await getIntegration(db!, actor, integrationId);
    const tweaked = structuredClone(current.definition) as any;
    tweaked.steps[0].label = "Read orders (edited by hand)";
    await saveDefinition(db!, actor, integrationId, tweaked, current.definitionHash);
    await expect(acceptAiChange(db!, actor, change.id)).rejects.toThrow(/changed after the AI read it/);
    expect((await getAiSession(db!, actor, session.id)).changes.at(-1)?.status).toBe("stale");
  });

  it("will not apply changes to an active integration", async () => {
    const session = await createAiSession(db!, actor, { projectId, title: "active" });
    await turn(
      session.id,
      new ScriptedModel([
        [
          use("c1", "propose_flow", {
            name: "Active one",
            summary: "s",
            schedule: { kind: "interval", expression: "PT1H", timezone: "UTC" },
            flow: goodFlow,
          }),
        ],
        [text("ok")],
      ]),
      "build",
    );
    const first = (await getAiSession(db!, actor, session.id)).changes[0]!;
    const { integrationId } = await acceptAiChange(db!, actor, first.id);
    // shop_api is a draft connection; activation only needs a valid definition
    await activateIntegration(db!, actor, integrationId);

    const edited = structuredClone(goodFlow) as any;
    edited.steps[0].label = "Changed";
    await turn(
      session.id,
      new ScriptedModel([
        [use("c2", "propose_flow", { name: "Active one", summary: "s", schedule: null, flow: edited })],
        [text("ok")],
      ]),
      "rename the first step",
    );
    const proposal = (await getAiSession(db!, actor, session.id)).changes.at(-1)!;
    await expect(acceptAiChange(db!, actor, proposal.id)).rejects.toThrow(/Deactivate/);
    await deactivateIntegration(db!, actor, integrationId);
    await rejectAiChange(db!, actor, proposal.id);
    expect((await getAiSession(db!, actor, session.id)).changes.at(-1)?.status).toBe("rejected");
  });

  it("stops after repeated invalid proposals and tells the model to explain", async () => {
    const session = await createAiSession(db!, actor, { projectId, title: "bad" });
    const bad = {
      name: "Bad",
      summary: "s",
      schedule: { kind: "interval", expression: "PT1H", timezone: "UTC" },
      flow: {
        schemaVersion: 1,
        style: "scheduled",
        trigger: { id: "t", type: "schedule" },
        steps: [{ id: "x", type: "teleport" }],
      },
    };
    const model = new ScriptedModel([
      [use("d1", "propose_flow", bad)],
      [use("d2", "propose_flow", bad)],
      [use("d3", "propose_flow", bad)],
      [text("I could not build this: I need to know which systems to use.")],
    ]);
    const r = await turn(session.id, model, "do the thing");
    expect(r.status).toBe("idle");
    expect(JSON.stringify(model.requests[3]?.messages.at(-1))).toContain("Stop proposing now");
    expect((await getAiSession(db!, actor, session.id)).changes).toHaveLength(0);
  });

  it("handles refusals and runaway loops", async () => {
    const s1 = await createAiSession(db!, actor, { projectId, title: "refuse" });
    const refusing = new ScriptedModel([[text("")]]);
    const turnFn = refusing.turn.bind(refusing);
    refusing.turn = async (...args) => ({ ...(await turnFn(...args)), stop_reason: "refusal" }) as never;
    const r1 = await turn(s1.id, refusing, "x");
    expect(r1.status).toBe("error");
    expect(r1.events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("declined") });

    const s2 = await createAiSession(db!, actor, { projectId, title: "loop" });
    const looping = new ScriptedModel(Array.from({ length: 20 }, (_, i) => [use(`l${i}`, "list_connections", {})]));
    const events: AiEvent[] = [];
    const status = await runTurn({
      db: db!,
      actor,
      sessionId: s2.id,
      text: "x",
      model: looping,
      emit: (e) => events.push(e),
      maxIterations: 4,
    });
    expect(status).toBe("error");
    expect(looping.requests).toHaveLength(4);
    // the session is usable again after an error
    expect((await getAiSession(db!, actor, s2.id)).session.status).toBe("error");
    await claimAiSession(db!, actor, s2.id);
  });

  it("runs one turn at a time per conversation", async () => {
    const session = await createAiSession(db!, actor, { projectId, title: "busy" });
    await claimAiSession(db!, actor, session.id);
    await expect(claimAiSession(db!, actor, session.id)).rejects.toThrow(/still working/);
  });
});
