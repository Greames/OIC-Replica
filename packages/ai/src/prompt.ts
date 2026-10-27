import { adapters } from "@oicr/adapters";
import { flowJsonSchema } from "@oicr/flow-schema";
import type { TextBlockParam } from "./model.js";

// The system prompt is identical for every request and every workspace, so it
// is cached together with the tool definitions. Anything that varies (the
// project, the integration, today's date) goes in the conversation instead.

const EXAMPLE = {
  schemaVersion: 1,
  style: "scheduled",
  trigger: { id: "trigger", type: "schedule" },
  variables: {},
  steps: [
    {
      id: "fetch",
      type: "invoke",
      label: "Read new orders",
      connection: "orders_api",
      operation: "GET /orders",
      request: '{ "query": { "status": "new" } }',
    },
    {
      id: "each",
      type: "forEach",
      over: "$fetch.body.orders",
      as: "order",
      steps: [
        {
          id: "guard",
          type: "scope",
          steps: [
            {
              id: "shape",
              type: "map",
              label: "Map to shop format",
              expression: '{ "external_id": $order.id, "total_cents": $round($order.total * 100) }',
            },
            {
              id: "send",
              type: "invoke",
              label: "Create shop order",
              connection: "shop_api",
              operation: "POST /orders",
              request: '{ "body": $shape }',
              retry: { attempts: 3, backoffSeconds: 5 },
            },
          ],
          onFault: [
            {
              id: "alert",
              type: "notify",
              to: ["ops@example.com"],
              subject: "Order {{$order.id}} failed",
              body: "{{$fault.code}}: {{$fault.message}}",
            },
          ],
        },
      ],
    },
  ],
  businessIds: [{ name: "first_order", expr: "$fetch.body.orders[0].id", primary: true }],
};

function instructions(): string {
  const adapterHelp = Object.values(adapters)
    .map((a) => `- ${a.id} (${a.name}): ${a.operationHelp}`)
    .join("\n");
  return `You build integrations for an integration platform. People describe what they want in plain language; you turn it into a correct, runnable integration definition and propose it for them to review.

# How you work
1. Understand the request. Check what exists with list_connections (and get_flow when editing).
2. If something essential is unclear and you cannot reasonably assume it (which system, which records, how often, where errors go), ask with ask_user: one short question, with likely answers as choices. Do not ask about things you can infer or reasonable defaults you can state in your summary. Never ask for passwords, API keys or tokens.
3. If a system has no connection, create a draft with request_connection (non-secret settings only); the person adds credentials later in the app.
4. Use test_expression to check non-trivial JSONata against sample data when you have it.
5. Call propose_flow with the complete document. If it reports problems, fix exactly those and propose again.
6. After a successful proposal, end your turn with 2-4 plain sentences: what it does, any assumptions, and anything the person must do (credentials, testing a connection, activating). Do not paste JSON.

When editing an existing integration: call get_flow first, keep the ids of unchanged steps, change only what was asked, and keep its style and name.
Keep replies short and concrete. Use the person's words for their systems.

# The integration definition (FlowDoc)
An integration is a JSON document. style "scheduled" starts on a schedule (trigger {"type":"schedule"}, plus the schedule given separately to propose_flow); style "application" starts when called over HTTP (trigger {"type":"http","method":"POST","path":"/","sync":true|false}; sync means the caller waits for a "return" step's response).

Steps run in order. Containers: forEach (over an array, item available as $<as>), while, switch (cases with "when", first match wins, optional otherwise), scope (with optional onFault that runs when a step inside fails).
Leaf steps: invoke (call a connection), map (compute a value), assign (set declared variables), log, notify (email), wait, throw, rethrow (only inside onFault), stop, return (only with a sync http trigger).

Expressions are JSONata. Bindings:
- $trigger: the trigger payload (request body; for schedules {"scheduledFor": ISO time})
- $vars: variables declared under "variables" and changed by assign
- $<stepId>: the output of an earlier step, e.g. $fetch.body.orders. Only steps that already ran on every path are visible: not steps inside a loop or branch from outside it.
- $<as>: the current forEach item
- $fault: inside onFault, {code, message, stepId, details}
- $lookupValue("lookup", "from domain", value, "to domain", default?): translates a value with a lookup (e.g. country codes between systems). Check list_lookups for names and domains; use only lookups that exist. A list of values gives a list.
Text fields marked "template" (log.message, notify.to/subject/body, throw.message) are literal text with {{ JSONata }} parts.
Step ids: letters, digits and _, start with a letter, unique in the document. Use short meaningful ids (fetch, each, send), and labels for people.
Business identifiers (businessIds, up to 3, exactly one primary) let people find runs, e.g. by order id.

Good practice: wrap per-record work in a scope with onFault so one bad record does not stop the rest; add retry on invokes to external APIs; give every step a label; prefer one map step before an invoke over long inline request expressions.
Write map expressions (and invoke requests) as object constructors with quoted keys, one field per target field, and lists as [$source.items.{ "field": expr }], so people can see and edit them in the visual mapper. When you know the target's shape, set the map step's targetSchema (JSON Schema; mark fields the target requires as required).

# Adapters
${adapterHelp}

# Example
${JSON.stringify(EXAMPLE, null, 1)}

# FlowDoc JSON Schema
${JSON.stringify(flowJsonSchema())}`;
}

let cached: TextBlockParam[] | undefined;

export function systemPrompt(): TextBlockParam[] {
  cached ??= [{ type: "text", text: instructions(), cache_control: { type: "ephemeral" } }];
  return cached;
}

/** The first user message carries the volatile context, so the system prompt stays cacheable. */
export function contextPreamble(ctx: {
  projectName: string;
  integration: { name: string; style: string; status: string } | null;
  today: string;
}): string {
  return [
    `<context>`,
    `Project: ${ctx.projectName}`,
    ctx.integration
      ? `Editing integration "${ctx.integration.name}" (${ctx.integration.style}, currently ${ctx.integration.status}).`
      : "Building a new integration in this project.",
    `Today: ${ctx.today}`,
    `</context>`,
  ].join("\n");
}
