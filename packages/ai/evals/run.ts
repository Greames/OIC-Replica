// The AI builder eval: real requests, run against Claude, graded by checks on
// the proposal. Run before changing the prompt, the tools or the model.
//
//   ANTHROPIC_API_KEY=... TEST_DATABASE_URL=postgres://... pnpm --filter @oicr/ai eval [case-id ...]
//
// Costs real tokens: every case is one conversation (a few model calls).

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type Actor,
  createAiSession,
  createConnection,
  createDb,
  createProject,
  getAiSession,
  listConnections,
  memberships,
  orgs,
  users,
} from "@oicr/db";
import { runMigrations } from "@oicr/db/migrate";
import { type FlowDoc, type Step, walkSteps } from "@oicr/flow-schema";
import { type AiEvent, AnthropicModel, runTurn } from "../src/index.js";

interface Case {
  id: string;
  prompt: string;
  connections: string[];
  answers?: string[];
  expect: {
    asks?: boolean;
    style?: "scheduled" | "application";
    uses?: string[];
    stepTypes?: Step["type"][];
    schedule?: boolean;
    cronTimezone?: string;
    sync?: boolean;
    newConnection?: boolean;
    retry?: boolean;
    businessIds?: boolean;
    expressionContains?: string[];
    noSecretInFlow?: string;
  };
}

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.log("Skipping the AI eval: set ANTHROPIC_API_KEY to run it (it uses real tokens).");
  process.exit(0);
}
if (!url) throw new Error("Set TEST_DATABASE_URL");
process.env.SECRETS_KEY ??= randomBytes(32).toString("base64");

const cases: Case[] = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const only = process.argv.slice(2);
const db = createDb(url);
const model = new AnthropicModel();

function check(c: Case, doc: FlowDoc | null, schedule: unknown, asked: number, createdConnections: string[]): string[] {
  const fails: string[] = [];
  const e = c.expect;
  if (e.asks && asked === 0) fails.push("expected a clarifying question");
  if (!doc) return [...fails, "no valid proposal"];
  if (e.style && doc.style !== e.style) fails.push(`style ${doc.style}, expected ${e.style}`);
  const types = new Set<string>();
  const used = new Set<string>();
  let retry = false;
  walkSteps(doc, ({ step }) => {
    types.add(step.type);
    if (step.type === "invoke") {
      used.add(step.connection);
      if (step.retry) retry = true;
    }
  });
  for (const u of e.uses ?? []) if (!used.has(u)) fails.push(`does not use ${u}`);
  for (const t of e.stepTypes ?? []) if (!types.has(t)) fails.push(`no ${t} step`);
  if (e.schedule && !schedule) fails.push("no schedule");
  if (e.cronTimezone && (schedule as { timezone?: string } | null)?.timezone !== e.cronTimezone)
    fails.push(`schedule not in ${e.cronTimezone}`);
  if (e.sync !== undefined && (doc.trigger.type !== "http" || doc.trigger.sync !== e.sync))
    fails.push(`sync should be ${e.sync}`);
  if (e.newConnection && createdConnections.length === 0) fails.push("did not draft the missing connection");
  if (e.retry && !retry) fails.push("no retry on invokes");
  if (e.businessIds && doc.businessIds.length === 0) fails.push("no business identifier");
  const text = JSON.stringify(doc);
  for (const s of e.expressionContains ?? []) if (!text.includes(s)) fails.push(`expressions lack "${s}"`);
  if (e.noSecretInFlow && text.includes(e.noSecretInFlow)) fails.push("put a secret into the flow");
  return fails;
}

async function runCase(c: Case) {
  const [u] = await db
    .insert(users)
    .values({ name: "Eval", email: `eval-${randomUUID()}@example.com` })
    .returning();
  const [o] = await db
    .insert(orgs)
    .values({ name: "Eval", slug: `eval-${randomUUID()}` })
    .returning();
  await db.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
  const actor: Actor = { userId: u!.id, orgId: o!.id, role: "admin" };
  const project = await createProject(db, actor, { name: "Eval" });
  for (const id of c.connections) {
    await createConnection(db, actor, {
      name: id.replace(/_/g, " "),
      identifier: id,
      adapter: "rest",
      properties: { baseUrl: `https://${id.replace(/_api$/, "")}.example.com` },
      authType: "bearer",
      secret: { token: "t" },
    });
  }
  const before = new Set(c.connections);
  const session = await createAiSession(db, actor, { projectId: project.id, title: c.id });
  const answers = [...(c.answers ?? [])];
  let asked = 0;
  let lastQuestion: { choices: string[] } | null = null;
  const started = Date.now();
  let status = await runTurn({
    db,
    actor,
    sessionId: session.id,
    text: c.prompt,
    model,
    emit: (e: AiEvent) => {
      if (e.type === "question") lastQuestion = e;
    },
  });
  while (status === "waiting" && asked < 3) {
    asked++;
    const q = lastQuestion as { choices: string[] } | null;
    const answer = answers.shift() ?? q?.choices[0] ?? "Use your best judgement.";
    status = await runTurn({
      db,
      actor,
      sessionId: session.id,
      text: answer,
      model,
      emit: (e: AiEvent) => {
        if (e.type === "question") lastQuestion = e;
      },
    });
  }
  const { session: s, changes } = await getAiSession(db, actor, session.id);
  const latest = changes.at(-1);
  const created = (await listConnections(db, actor)).map((x) => x.identifier).filter((x) => !before.has(x));
  const fails = check(c, (latest?.proposedDefinition as FlowDoc) ?? null, latest?.schedule ?? null, asked, created);
  return {
    id: c.id,
    ok: fails.length === 0,
    fails,
    asked,
    seconds: Math.round((Date.now() - started) / 1000),
    tokens: s.inputTokens + s.outputTokens,
    status,
  };
}

await runMigrations(url);
const results = [];
for (const c of cases.filter((x) => only.length === 0 || only.includes(x.id))) {
  try {
    const r = await runCase(c);
    results.push(r);
    console.log(
      `${r.ok ? "PASS" : "FAIL"} ${r.id} (${r.seconds}s, ${r.tokens} tokens, ${r.asked} question(s))${r.ok ? "" : `\n     ${r.fails.join("\n     ")}`}`,
    );
  } catch (e) {
    results.push({ id: c.id, ok: false, fails: [(e as Error).message] });
    console.log(`ERROR ${c.id}: ${(e as Error).message}`);
  }
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed with ${model.model}`);
await db.$client.end();
process.exit(passed === results.length ? 0 : 1);
