import { adapters } from "@oicr/adapters";
import {
  type Actor,
  type AiSession,
  aiChanges,
  connectionIndex,
  createAiChange,
  createConnection,
  type Db,
  getIntegration,
  listConnections,
  listLookups,
  loadLookup,
  lookupNames,
  ScheduleInput,
  toConnectionIdentifier,
} from "@oicr/db";
import {
  diffFlows,
  type FlowDoc,
  type Issue,
  isEmptyDiff,
  LOOKUP_FUNCTION,
  lookupFunction,
  validateFlow,
} from "@oicr/flow-schema";
import { and, desc, eq } from "drizzle-orm";
import jsonata from "jsonata";
import { z } from "zod";
import type { Tool } from "./model.js";

// The AI builder's tools. The model can read the workspace, ask the user,
// draft connections without secrets, test expressions, and propose flows.
// It cannot save, activate, delete, or see credentials.

export interface ToolContext {
  db: Db;
  actor: Actor;
  session: AiSession;
  /** Failed propose_flow calls in this turn; capped to stop endless repair loops. */
  failedProposals: number;
  emit: (event: AiEvent) => void;
}

export type AiEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "question"; question: string; choices: string[] }
  | { type: "proposal"; changeId: string; summary: string }
  | { type: "connection"; id: string; identifier: string; name: string }
  | { type: "error"; message: string }
  | { type: "done"; status: "idle" | "waiting" | "error" };

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

export const MAX_FAILED_PROPOSALS = 3;

const strictObject = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: Tool[] = [
  {
    name: "list_adapters",
    description:
      "List the adapters (system types) connections can use, with their operation format and connection settings. Call this before proposing invokes for an adapter you have not used in this conversation.",
    strict: true,
    input_schema: strictObject({}),
  },
  {
    name: "list_connections",
    description:
      "List the workspace's connections: identifier (what a flow's invoke.connection must use), adapter, role, status (configured = tested and working, draft = credentials missing or untested) and base URL. Never shows credentials.",
    strict: true,
    input_schema: strictObject({}),
  },
  {
    name: "list_lookups",
    description:
      'List the workspace\'s lookups (value maps between systems, e.g. country codes): name, domains (columns) and a few example rows. Use them in expressions as $lookupValue("name", "from domain", value, "to domain", default?).',
    strict: true,
    input_schema: strictObject({}),
  },
  {
    name: "get_flow",
    description:
      "Get the integration this conversation is editing (name, style, status, schedule and its current definition), plus the latest proposal made in this conversation. Returns integration: null when building a new one.",
    strict: true,
    input_schema: strictObject({}),
  },
  {
    name: "infer_schema",
    description:
      "Describe the shape of a sample JSON payload the user pasted (field paths and types). Use it to write correct JSONata paths.",
    strict: true,
    input_schema: strictObject({ sample: { type: "string", description: "The JSON text, exactly as given." } }),
  },
  {
    name: "test_expression",
    description:
      'Evaluate a JSONata expression against sample data before using it in a flow. bindings_json is a JSON object of variables, e.g. {"trigger": {...}, "get": {"body": {...}}} makes $trigger and $get available. Returns the result or the error.',
    strict: true,
    input_schema: strictObject({
      expression: { type: "string" },
      bindings_json: { type: "string", description: "JSON object of variable name to value. Use {} for none." },
    }),
  },
  {
    name: "ask_user",
    description:
      "Ask the user one short question when you cannot build a correct flow without the answer (which system, which fields, how often, what to do on failure). Offer 2-4 likely answers as choices when you can; the user may also type their own. The conversation pauses until they answer. Do not ask for passwords, tokens or keys.",
    strict: true,
    input_schema: strictObject({
      question: { type: "string" },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "2-4 suggested answers, or [] for open questions.",
      },
    }),
  },
  {
    name: "request_connection",
    description:
      "Create a draft REST connection when the flow needs a system that has no connection yet. You give the non-secret settings; the user enters the credentials and tests it in the app. Returns its identifier for use in invoke.connection. Use only after list_connections shows nothing suitable.",
    strict: true,
    input_schema: strictObject({
      name: { type: "string", description: "Human name, e.g. 'Shop API'." },
      identifier: { type: "string", description: "lowercase_with_underscores, e.g. shop_api." },
      base_url: { type: "string", description: "Full base URL, e.g. https://api.example.com/v1" },
      auth_type: { type: "string", enum: ["none", "basic", "api_key", "bearer"] },
      reason: { type: "string", description: "One sentence for the user: why this connection is needed." },
    }),
  },
  {
    name: "propose_flow",
    description:
      "Propose the complete integration definition (a FlowDoc, see the system prompt). It is validated first; if it has problems you get them back with their JSON paths, fix them and call again. A valid proposal is shown to the user to review; nothing is saved until they accept it. Always send the whole document, keeping existing step ids for unchanged steps.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Integration name, e.g. 'Orders to shop'. Keep the existing name when editing.",
        },
        summary: {
          type: "string",
          description: "2-4 sentences for the user: what it does, and what changed when editing.",
        },
        schedule: {
          type: ["object", "null"],
          description:
            "For scheduled integrations: {kind: 'interval'|'cron', expression, timezone}. Interval is ISO-8601 (PT15M); cron has 5 fields. null for application integrations or to keep the current schedule.",
          properties: {
            kind: { type: "string", enum: ["interval", "cron"] },
            expression: { type: "string" },
            timezone: { type: "string" },
          },
        },
        flow: { type: "object", description: "The full FlowDoc." },
      },
      required: ["name", "summary", "schedule", "flow"],
    },
  },
];

const Inputs = {
  infer_schema: z.object({ sample: z.string() }),
  test_expression: z.object({ expression: z.string(), bindings_json: z.string() }),
  ask_user: z.object({ question: z.string().min(1), choices: z.array(z.string()).max(6) }),
  request_connection: z.object({
    name: z.string().min(1),
    identifier: z.string().min(1),
    base_url: z.string(),
    auth_type: z.enum(["none", "basic", "api_key", "bearer"]),
    reason: z.string(),
  }),
  propose_flow: z.object({
    name: z.string().min(1).max(100),
    summary: z.string().min(1),
    schedule: z
      .object({ kind: z.enum(["interval", "cron"]), expression: z.string(), timezone: z.string().default("UTC") })
      .nullable(),
    flow: z.record(z.string(), z.unknown()),
  }),
};

export const ASK_USER = "ask_user";

export function parseAskUser(input: unknown) {
  return Inputs.ask_user.safeParse(input);
}

const json = (v: unknown) => JSON.stringify(v, null, 1);

/** Compact type tree of a JSON value: { orders: [{ id: "string", total: "number" }] } */
export function describeShape(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.length === 0 ? ["unknown"] : [describeShape(value[0], depth + 1)];
  if (value === null) return "null";
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as object)
        .slice(0, 60)
        .map(([k, v]) => [k, describeShape(v, depth + 1)]),
    );
  }
  return typeof value;
}

function formatIssues(issues: Issue[]): string {
  return issues
    .slice(0, 25)
    .map((i) => `- ${i.path.join(".") || "(document)"}${i.stepId ? ` [step ${i.stepId}]` : ""}: ${i.message}`)
    .join("\n");
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const { db, actor, session } = ctx;
  switch (name) {
    case "list_adapters":
      return {
        content: json(
          Object.values(adapters).map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            roles: a.roles,
            authTypes: a.authTypes,
            operations: a.operationHelp,
            settings: a.fields.filter((f) => !f.secret).map((f) => f.key),
          })),
        ),
      };

    case "list_connections": {
      const rows = await listConnections(db, actor);
      return {
        content: json(
          rows.map((c) => ({
            identifier: c.identifier,
            name: c.name,
            adapter: c.adapter,
            role: c.role,
            status: c.status,
            baseUrl: c.properties.baseUrl ?? null,
            credentialsStored: c.hasSecret,
          })),
        ),
      };
    }

    case "list_lookups": {
      const rows = await listLookups(db, actor);
      const withExamples = await Promise.all(
        rows.map(async (l) => ({
          name: l.name,
          description: l.description,
          domains: l.domains,
          rows: l.rowCount,
          examples: ((await loadLookup(db, actor.orgId, l.name))?.rows ?? []).slice(0, 5),
        })),
      );
      return { content: json(withExamples) };
    }

    case "get_flow": {
      const integration = session.integrationId ? await getIntegration(db, actor, session.integrationId) : null;
      const [latest] = await db
        .select()
        .from(aiChanges)
        .where(and(eq(aiChanges.sessionId, session.id)))
        .orderBy(desc(aiChanges.createdAt))
        .limit(1);
      return {
        content: json({
          integration: integration && {
            name: integration.name,
            identifier: integration.identifier,
            style: integration.style,
            status: integration.status,
            schedule: integration.schedule && {
              kind: integration.schedule.kind,
              expression: integration.schedule.expression,
              timezone: integration.schedule.timezone,
            },
            definition: integration.definition,
          },
          latestProposal: latest && { status: latest.status, name: latest.name, definition: latest.proposedDefinition },
        }),
      };
    }

    case "infer_schema": {
      const { sample } = Inputs.infer_schema.parse(input);
      try {
        return { content: json(describeShape(JSON.parse(sample))) };
      } catch (e) {
        return { content: `Not valid JSON: ${(e as Error).message}`, isError: true };
      }
    }

    case "test_expression": {
      const { expression, bindings_json } = Inputs.test_expression.parse(input);
      let bindings: Record<string, unknown>;
      try {
        bindings = JSON.parse(bindings_json || "{}");
      } catch (e) {
        return { content: `bindings_json is not valid JSON: ${(e as Error).message}`, isError: true };
      }
      try {
        const lookupValue = lookupFunction((name) => loadLookup(db, actor.orgId, name));
        const result = await jsonata(expression).evaluate(bindings.trigger ?? {}, {
          [LOOKUP_FUNCTION]: lookupValue,
          ...bindings,
        });
        return { content: json({ result: result === undefined ? null : JSON.parse(JSON.stringify(result)) }) };
      } catch (e) {
        return { content: `Expression error: ${(e as Error).message}`, isError: true };
      }
    }

    case "request_connection": {
      const data = Inputs.request_connection.parse(input);
      const identifier = toConnectionIdentifier(data.identifier);
      const existing = (await listConnections(db, actor)).find((c) => c.identifier === identifier);
      if (existing) {
        return {
          content: json({
            identifier,
            status: existing.status,
            note: "A connection with this identifier already exists; use it.",
          }),
        };
      }
      try {
        const conn = await createConnection(db, actor, {
          name: data.name,
          identifier,
          adapter: "rest",
          role: "invoke",
          properties: { baseUrl: data.base_url },
          authType: data.auth_type,
          secret: null,
        });
        ctx.emit({ type: "connection", id: conn.id, identifier: conn.identifier, name: conn.name });
        return {
          content: json({
            identifier: conn.identifier,
            status: "draft",
            note: "Created without credentials. The user will enter them and test it; tell them so in your reply. You can already use this identifier in the flow.",
          }),
        };
      } catch (e) {
        return { content: `Could not create the connection: ${(e as Error).message}`, isError: true };
      }
    }

    case "propose_flow":
      return proposeFlow(input, ctx);

    default:
      return { content: `Unknown tool ${name}.`, isError: true };
  }
}

async function proposeFlow(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const { db, actor, session } = ctx;
  const parsed = Inputs.propose_flow.safeParse(input);
  if (!parsed.success) {
    ctx.failedProposals++;
    return {
      content: `The tool input is malformed: ${parsed.error.issues[0]?.message}. Send name, summary, schedule and flow.`,
      isError: true,
    };
  }
  const { name, summary, schedule, flow } = parsed.data;
  const integration = session.integrationId ? await getIntegration(db, actor, session.integrationId) : null;

  const result = validateFlow(flow, {
    connections: await connectionIndex(db, actor.orgId),
    lookups: await lookupNames(db, actor.orgId),
  });
  const errors: Issue[] = [...result.errors];
  if (integration && (flow as { style?: string }).style !== integration.style) {
    errors.push({
      code: "schema",
      message: `This integration is "${integration.style}"; keep style "${integration.style}".`,
      path: ["style"],
    });
  }
  let scheduleValue: { kind: "interval" | "cron"; expression: string; timezone: string } | null = null;
  const style = (flow as { style?: string }).style;
  if (schedule && style === "scheduled") {
    const s = ScheduleInput.safeParse(schedule);
    if (!s.success)
      errors.push({ code: "schema", message: `schedule: ${s.error.issues[0]?.message}`, path: ["schedule"] });
    else scheduleValue = { kind: s.data.kind, expression: s.data.expression, timezone: s.data.timezone };
  }
  if (style === "scheduled" && !schedule && !integration?.schedule) {
    errors.push({
      code: "schema",
      message: "A new scheduled integration needs a schedule. Ask the user how often if they did not say.",
      path: ["schedule"],
    });
  }

  if (errors.length > 0 || !result.doc) {
    ctx.failedProposals++;
    const last = ctx.failedProposals >= MAX_FAILED_PROPOSALS;
    return {
      isError: true,
      content: `The proposal has ${errors.length} problem(s):\n${formatIssues(errors)}\n${
        last
          ? "Stop proposing now. Tell the user in plain words what is blocking and what you need from them."
          : "Fix them and call propose_flow again with the whole document."
      }`,
    };
  }

  const doc = result.doc as FlowDoc;
  const diff = diffFlows(integration ? (integration.definition as FlowDoc) : null, doc);
  if (integration && isEmptyDiff(diff) && !scheduleValue) {
    return {
      content:
        "This is identical to the current integration. Tell the user nothing needed to change, or ask what they want different.",
      isError: true,
    };
  }
  const change = await createAiChange(db, {
    orgId: actor.orgId,
    sessionId: session.id,
    integrationId: integration?.id ?? null,
    baseHash: integration?.definitionHash ?? null,
    name: integration?.name ?? name,
    summary,
    proposedDefinition: doc,
    schedule: scheduleValue,
    diff,
    warnings: result.warnings,
  });
  ctx.emit({ type: "proposal", changeId: change.id, summary });

  const drafts = (await listConnections(db, actor)).filter((c) => c.status !== "configured").map((c) => c.identifier);
  const used = new Set<string>();
  JSON.stringify(doc, (k, v) => {
    if (k === "connection" && typeof v === "string") used.add(v);
    return v;
  });
  const needsSetup = [...used].filter((u) => drafts.includes(u));
  return {
    content: json({
      proposalId: change.id,
      status: "shown to the user for review",
      changes: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length },
      warnings: result.warnings.map((w) => w.message),
      connectionsNeedingSetup: needsSetup,
      next: "End your turn with a short summary (2-4 sentences). Mention connections needing credentials or a test, if any. Do not repeat the JSON.",
    }),
  };
}
