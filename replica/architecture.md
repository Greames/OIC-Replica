# Architecture: OIC-Replica (working name), an AI-first integration platform

A rebuild of Oracle Integration 3's core features (see `recon.md`), with an AI
builder as the main way to create integrations. Also: an MCP server, so
agents like Hermes Agent can build, operate and report on integrations from
Telegram, Slack and other chat apps. Working name only; `/replica-brand`
renames it before launch.

## Principles

1. **One flow definition, three editors.** A typed JSON document (the
   "FlowDoc") is the single source of truth. The canvas edits it, the AI
   proposes changes to it, and the API/MCP read and write it. All three go
   through the same validator. Getting this format right comes first.
2. **AI proposes, humans dispose.** The model only ever creates `ai_changes`
   (proposals). A person accepts them. Activation, deletion and secrets are
   never available as model tools.
3. **Everything is an event.** Every state change writes an `events` row in
   the same transaction (outbox). The UI (live updates), webhooks,
   Slack/Telegram and Hermes all read from that one stream. That is how
   "every update" reaches you.
4. **One database, one repo, two processes.** Postgres for data, queue and
   events. A web app and a worker. No microservices.
5. **Self-hostable from day one.** `docker compose up` runs the whole thing.
   This is a selling point against OIC's per-instance hourly billing.

## Stack

| layer | choice | why |
| --- | --- | --- |
| language | TypeScript everywhere (Node 22) | one language for UI, engine, adapters and AI tools; shared Zod types |
| repo | pnpm workspaces + Turborepo | apps and packages in one place, fast cached builds |
| web | Next.js 16 (App Router, React 19) | server actions + route handlers for the API; streaming for the AI chat |
| UI | Tailwind CSS v4 + shadcn/ui + lucide icons | modern, accessible, our own components; tokens come from replica-design |
| canvas | React Flow (@xyflow/react) + our own tree layout | React Flow gives pan/zoom/rendering; a FlowDoc is a tree, so a small deterministic layout fits better than a general graph layout (elkjs) and keeps AI-built flows tidy |
| mapper UI | custom two-tree component + Monaco for expressions | nothing off the shelf fits; Monaco gives autocomplete over the schema |
| database | Postgres 16 (Neon or Supabase managed; plain Postgres self-hosted) | relational data + jsonb for flow docs, payload metadata, events |
| ORM | Drizzle | SQL-first, typed, light migrations |
| queue / durable jobs | pg-boss on the same Postgres | durable, retryable jobs without new infra; swap for Temporal only if scale demands it |
| flow engine | own interpreter in `packages/engine` | executes FlowDoc step by step, persists each step, resumable; the product's core, so we own it |
| mapping language | JSONata | JSON-native, expressive, sandboxable, and LLMs write it well; replaces OIC's XSLT/XPath |
| custom JS | isolated-vm | runs user JS libraries with memory/time limits and no network |
| auth | Better Auth (email + Google, orgs plugin) | self-hostable, owns its tables in our Postgres, has organizations/roles built in |
| secrets | AES-256-GCM envelope encryption, master key from env or a cloud KMS | credentials never leave the server; never sent to the model |
| AI | Gemini (default, `@google/genai`), Claude (`@anthropic-ai/sdk`) or GPT (`openai`, Responses API), tool use + streaming | one `ModelClient` interface; `AI_PROVIDER` picks, models per provider (`GEMINI_MODEL`, `ANTHROPIC_MODEL`, `OPENAI_MODEL`), effort with `AI_EFFORT`. Compare providers with the eval before switching |
| agent protocol | MCP server (`@modelcontextprotocol/sdk`, streamable HTTP) | lets Hermes Agent, Claude Desktop, Claude Code or any MCP client drive the platform |
| realtime | Server-Sent Events from Postgres LISTEN/NOTIFY | live run status and AI progress without a websocket service |
| payload storage | S3-compatible (Cloudflare R2 / MinIO self-hosted) | payloads up to 1 GB never sit in Postgres |
| email | Resend (SMTP fallback) | notifications and the email action |
| payments | Stripe Billing, metered on messages/hour | mirrors how the market prices iPaaS (Phase 9) |
| observability (our own) | OpenTelemetry + Sentry | traces across web → queue → engine → adapters |
| tests | Vitest (unit), Playwright (e2e), an AI eval suite (`evals/`) | the eval suite measures the AI builder on 50+ real requests |
| hosting | Docker images; Fly.io or Render for web + worker, Neon for Postgres, R2 for files | the worker is long-running, so not serverless-only; same images self-host |

## Repo layout

```
apps/
  web/            Next.js: UI, REST API (/api/v1), trigger endpoints (/t/...), SSE, AI chat
  worker/         pg-boss consumers: engine runs, schedules, event dispatcher, deliveries
  mcp/            MCP server (streamable HTTP), mounted in web or run alone
packages/
  flow-schema/    FlowDoc Zod schema, validator, diff/patch, JSON Schema export for the model
  engine/         the interpreter: nodes, scopes, faults, loops, step persistence
  adapters/       adapter SDK + rest, http-trigger, scheduler, email, then sftp, postgres, mysql, soap
  mapping/        JSONata runtime, function library, lookups, schema inference from samples
  ai/             provider interface, tools, system prompts, builder loop, guardrails
  db/             Drizzle schema, migrations, repos (org-scoped data access)
  auth/           Better Auth config (email + Google, organizations, roles)
  events/         outbox writer, event types, formatters (one-liners for chat)
  ui/             shared components, tokens
evals/            AI builder eval cases + runner
replica/          recon, architecture, features (this folder)
docker-compose.yml  postgres, minio, web, worker, mcp
```

## The FlowDoc (sketch, finalised in Phase 0)

```jsonc
{
  "schemaVersion": 1,
  "style": "scheduled",
  "trigger": { "id": "t1", "type": "schedule" },
  "variables": { "lastRun": { "type": "string" } },
  "steps": [
    { "id": "n1", "type": "invoke", "connection": "orders_db", "operation": "query",
      "config": { "sql": "select * from orders where created_at > :since" },
      "input": { "since": "$vars.lastRun" } },
    { "id": "n2", "type": "forEach", "over": "$n1.rows", "as": "order", "steps": [
      { "id": "n3", "type": "scope", "steps": [
        { "id": "n4", "type": "invoke", "connection": "shop_api", "operation": "POST /orders",
          "map": "{ \"external_id\": order.id, \"total_cents\": $round(order.total * 100) }" }
      ], "onFault": [
        { "id": "n5", "type": "notify", "channel": "email", "to": "ops@example.com",
          "subject": "Order {{order.id}} failed", "body": "{{$fault.message}}" }
      ] }
    ] }
  ],
  "businessIds": [{ "name": "order", "expr": "order.id", "primary": true }]
}
```

Node types (v1): `invoke`, `map`, `assign`, `switch`, `forEach`, `while`,
`scope` (with `onFault`), `throw`, `rethrow`, `log`, `notify`, `wait`, `stop`,
`return` (sync response), `js`. Ids are stable, so the AI can address
nodes in edits ("insert after n4") and diffs stay small.

## The AI builder

A tool-use loop in `packages/ai`, streamed to S28. The model works only
through tools. It never writes the FlowDoc as free text that someone pastes
in.

| tool | does | side effects |
| --- | --- | --- |
| `list_adapters` | adapters, their operations and connection fields | none |
| `list_connections` | the org's connections (name, adapter, role, status; no secrets) | none |
| `describe_operation` | request/response schema for a connection operation | may call the target's metadata endpoint (OpenAPI, DB columns) |
| `infer_schema` | JSON Schema from a sample payload the user pasted | none |
| `get_flow` | the current FlowDoc + hash | none |
| `ask_user` | a clarifying question with optional choices (S28 card) | pauses the loop |
| `request_connection` | asks the user to create a connection with given adapter + non-secret fields prefilled | creates a draft connection; the user enters secrets in S16 |
| `propose_flow` / `propose_patch` | whole FlowDoc, or a JSON-patch against `get_flow` | validated; on failure, the errors go back to the model (max 3 repairs); on success, creates an `ai_changes` row |
| `test_map` | runs a JSONata map against sample input | none |
| `dry_run` | runs the proposed flow with mocked or sandboxed invokes | a `dry_run` instance |
| `explain_instance` | reads an instance's steps + error | none |

Guardrails: no activate/delete/secret tools. Payload samples are redacted for
fields named like secrets. Every model call is logged in `ai_messages`
(tokens metered in `usage_hourly`). `ai_changes.base_hash` must equal the
current `definition_hash` at apply time, or the proposal is marked `stale`
and re-planned. The eval suite (`evals/`) must pass before any prompt or
model change ships.

## Hermes Agent and "every update"

Updates reach people three ways, all fed from the `events` outbox:

1. **In the app.** Live via SSE (run status, AI progress, toasts).
2. **Direct channels.** `notification_channels`: Slack incoming webhook,
   Telegram bot, email, generic signed webhook. Filtered by event type and
   severity. These work with no agent at all.
3. **Hermes Agent (or any MCP client).** The `apps/mcp` server exposes:
   - read: `list_projects`, `list_integrations`, `get_integration`,
     `list_instances`, `get_instance`, `list_events(since_id, types?)`,
     `get_usage`
   - build: `start_ai_build(prompt)`, `continue_ai_build(session, answer)`,
     `list_ai_changes`, `accept_ai_change` (only with the `build` scope)
   - operate: `activate_integration`, `deactivate_integration`,
     `resubmit_instance`, `pause_schedule` (only with the `operate` scope;
     each one is a deliberate human-held capability, see below)

   Hermes is added as an MCP server in its config with an API key. A Hermes
   cron job (every few minutes) calls `list_events(since_id)` and posts the
   new ones to your Telegram/Slack, keeping the cursor. Because Hermes has
   memory and an LLM, it can also summarise ("3 failures on orders-sync since
   9am, all 401 from shop_api; the token likely expired") and take
   instructions back from the chat ("resubmit them", "build an integration
   that..."). Keys carry scopes, so a read-only key only reports.

   Checked against Hermes's docs in Phase 4: `mcp_servers.<name>.url` +
   `headers` (+ `trust: untrusted`) for MCP, and webhook routes under
   `platforms.webhook.extra.routes` with `deliver_only: true` for zero-token
   pushes. See the Phase 4 notes and `docs/hermes.md`.

Event types (v1): `integration.created|updated|activated|deactivated|activation_failed`,
`instance.failed|succeeded` (succeeded off by default), `instance.resubmitted`,
`schedule.paused`, `connection.test_failed`, `ai.change.proposed|accepted|rejected`,
`ai.question` (the AI is waiting for an answer), `usage.threshold`.

## Schema

Tables: 19 (plus Better Auth's 4). Access rules: data-layer checks. Every
repo function takes `{ orgId, role }` and no raw query runs without it. RLS
can be added later. See `schema.sql`.

## API

Route handlers under `/api/v1` (session cookie or `Authorization: Bearer <api key>`).
Server actions call the same repo functions.

| method path | does | who | input | output | flow |
| --- | --- | --- | --- | --- | --- |
| GET /api/v1/projects | list projects | viewer+ | — | Project[] | F01 |
| POST /api/v1/projects | create project | developer+ | name, identifier | Project | F01 |
| GET /api/v1/adapters | adapter catalogue + schemas | viewer+ | — | Adapter[] | F01 |
| GET /api/v1/connections | list | viewer+ | projectId? | Connection[] (no secrets) | F01 |
| POST /api/v1/connections | create | developer+ | adapter, props, auth, secret | Connection | F01 F10 |
| PATCH /api/v1/connections/:id | update | developer+ | partial | Connection | F01 |
| POST /api/v1/connections/:id/test | test | developer+ | — | {ok, error} | F01 F09 |
| GET /api/v1/integrations | list | viewer+ | projectId?, status? | Integration[] | F01 |
| POST /api/v1/integrations | create | developer+ | name, style, definition? | Integration | F01 F02 |
| GET /api/v1/integrations/:id | get with FlowDoc | viewer+ | — | Integration | F01 |
| PUT /api/v1/integrations/:id/definition | save FlowDoc | developer+ | definition, baseHash | Integration or 409 | F01 F07 |
| POST /api/v1/integrations/:id/validate | validate | developer+ | — | errors[] | F01 |
| POST /api/v1/integrations/:id/activate | activate | developer+ (human only from UI; API key needs `operate`) | tracingLevel | Integration | F01 F07 |
| POST /api/v1/integrations/:id/deactivate | deactivate | developer+ | — | Integration | F07 |
| POST /api/v1/integrations/:id/versions | new version from current | developer+ | — | Integration | F07 |
| POST /api/v1/integrations/:id/run | manual / test run | developer+ | payload | Instance | F01 |
| PUT /api/v1/integrations/:id/schedule | set schedule | developer+ | kind, expression, tz | Schedule | F02 |
| GET/POST/PATCH /api/v1/lookups | lookups CRUD + CSV import | developer+ | — | Lookup | F06 |
| POST /api/v1/mapping/test | test a JSONata map | developer+ | expr, input | output or error | F10 |
| GET /api/v1/instances | search runs | monitor+ | integrationId, status, businessId, from, to, cursor | Instance[] | F04 F05 |
| GET /api/v1/instances/:id | run + steps | monitor+ | — | Instance + steps | F04 |
| GET /api/v1/instances/:id/steps/:seq/payload | payload | monitor+ | in/out | stream | F04 |
| POST /api/v1/instances/resubmit | resubmit one or many | monitor+ (`operate` for keys) | ids[] | Instance[] | F04 |
| POST /api/v1/instances/discard | discard | monitor+ | ids[] | — | F04 |
| GET /api/v1/dashboard | counters by window | monitor+ | window | stats | F04 |
| POST /api/v1/ai/sessions | start AI build/edit | developer+ | prompt, projectId, integrationId? | session (SSE stream) | F10 F11 |
| POST /api/v1/ai/sessions/:id/messages | answer / follow up | developer+ | text or choice | SSE stream | F10 |
| POST /api/v1/ai/changes/:id/accept | apply a proposal (all or node ids) | developer+ | nodeIds? | Integration | F10 F11 |
| POST /api/v1/ai/changes/:id/reject | reject | developer+ | reason? | — | F10 |
| POST /api/v1/ai/instances/:id/explain | explain a failure | monitor+ | — | SSE stream | F12 |
| GET /api/v1/events | event feed | viewer+ | sinceId, types | Event[] | Hermes |
| GET /api/v1/events/stream | live events (SSE) | viewer+ | — | stream | all |
| CRUD /api/v1/channels | notification channels | admin | kind, config, filters | Channel | Hermes |
| CRUD /api/v1/api-keys | keys for API/MCP | admin | name, scopes | key (shown once) | Hermes |
| POST /api/v1/import, GET /api/v1/projects/:id/export | move projects | admin | archive | report | F08 |
| ANY /t/:org/:integration/:version/* | trigger endpoint for active application integrations | per-integration auth (basic / API key / OAuth) | payload | sync response or 202 | F01 F10 |
| POST /mcp | MCP server (streamable HTTP) | API key with scopes | MCP | MCP | Hermes |

Webhooks in: trigger endpoints (`/t/...`), Stripe (Phase 9), OAuth callbacks
for authorization-code connections.
Webhooks out: signed (`HMAC-SHA256`, `X-Signature`, event id for
idempotency) to generic webhook channels; Slack and Telegram via their
official APIs with the user's own webhook/bot token.

Jobs (pg-boss, in `apps/worker`):

| job | schedule | does |
| --- | --- | --- |
| `run-instance` | on demand | executes a FlowDoc; persists steps; writes events |
| `scheduler-tick` | every 15 s | claims due `schedules` with `for update skip locked`, enqueues runs, computes next_run_at in the schedule's time zone |
| `dispatch-events` | LISTEN on new events + every 5 s sweep | fans out to SSE, creates `deliveries` |
| `deliver` | on demand, retries with backoff (1m, 5m, 30m, 2h) | posts to Slack/Telegram/webhook/email |
| `meter` | every minute | rolls message and token counts into `usage_hourly` |
| `retention` | daily 03:00 UTC | deletes payloads past the plan's retention, old steps and events |
| `agent-heartbeat-check` | every minute (Phase 9) | marks agent groups offline |

## The parts that bite

- **Time zones:** schedules store an IANA zone and compute next_run_at
  there, so DST shifts happen in the right place. All stored times are UTC.
  The UI shows the user's zone.
- **Idempotency:** trigger endpoints accept `Idempotency-Key`, with a unique
  index per integration. Deliveries are unique per (event, channel). The
  engine persists each step before moving on, so a crashed worker resumes at
  the last finished step instead of re-invoking.
- **Races:** two workers can never claim the same schedule
  (`skip locked`). Saving a FlowDoc requires `baseHash` (409 on conflict).
  AI proposals go stale if the flow changed underneath them. An overlapping
  scheduled run is skipped unless `allow_overlap`.
- **Sync timeouts:** application integrations that return a response are
  capped (default 120 s, max 300 s as in OIC). Past that the caller gets 504
  and the instance is marked failed and recoverable.
- **Payload limits:** 100 MB structured, 10 MB for DB/queue adapters, 1 GB
  binary, streamed to object storage. Enforced at the trigger and in each
  adapter.
- **Rate limits:** per-connection concurrency and requests-per-second in
  adapter config. Per-org API and trigger rate limits. Per-org AI token
  budgets.
- **AI cost and failure:** token metering per org, a cap per session, a
  repair loop limited to 3, cheap models for summaries, and prompt caching on
  the system prompt and tool schemas.
- **Security:** secrets are encrypted at rest and never logged or sent to
  the model. User JS runs in isolated-vm with no network. Outbound invokes
  block private IP ranges (SSRF) unless routed through an agent. Scoped API
  keys.
- **Multi-tenancy:** org_id on every row, checked in every repo function.
  Payload storage keys are prefixed by org. Per-org queue fairness (a
  pg-boss singleton key per org for heavy jobs).
- **GDPR deletion:** deleting an org cascades all rows. Payload objects
  deleted by prefix. Retention job by plan.
- **Email deliverability:** Resend with a verified domain; notification
  digests to avoid floods.

## Build order (one phase at a time)

Each phase ends with something you can click, a passing test suite, and an
event feed that reports it. Feature rows refer to `features.csv`.

| phase | name | delivers | screens | tables | routes |
| --- | --- | --- | --- | --- | --- |
| **0** ✅ | Foundation | monorepo, docker compose (Postgres, MinIO), Drizzle schema + migration, Better Auth sign-in with orgs, app shell + nav, **FlowDoc schema + validator + tests**, CI | S01, S27 | orgs, memberships, projects + auth | projects |
| **1** ✅ | Vertical slice | REST connection (basic/API key) with test, a scheduled or REST-triggered integration whose FlowDoc is edited as JSON, engine runs invoke → map → invoke, instances list + detail with steps | S02-S04, S14-S16, S21, S22 (basic) | connections, integrations, schedules, instances, instance_steps | connections, integrations, run, activate, instances, /t/... |
| **2** ✅ | AI builder v1 | chat panel, Claude tool loop with list/describe/infer/ask/propose/test_map, validation + repair, diff review, accept → integration, eval suite v1 (20 cases) | S28, S29 | ai_sessions, ai_messages, ai_changes | ai/* |
| **3** ✅ | Visual canvas | React Flow canvas rendering the FlowDoc with elk layout, insert/move/delete nodes, all v1 node types, validation badges, read-only replay in S22, AI edits shown on canvas | S06, S22 | — | definition, validate |
| **4** ✅ | Every update: events, channels, MCP, Hermes | outbox + SSE live UI, Slack/Telegram/webhook/email channels, API keys with scopes, MCP server, Hermes setup guide + example cron job | S26 (channels, keys) | events, notification_channels, deliveries, api_keys | events, channels, api-keys, /mcp |
| **5** ✅ | Mapper + lookups | two-tree mapper over JSONata, function palette, test pane, lookups with CSV, schema inference from samples, AI-generated maps shown here | S08, S09, S17 | lookups | lookups, mapping/test |
| **6** | Operations | errors list, resubmit/discard (single + bulk), business identifiers, dashboard, AI "explain this failure" | S11, S20, S23, S24 | — | resubmit, discard, dashboard, explain |
| **7** | Adapters | adapter SDK docs, SFTP, Postgres, MySQL, SOAP, email; build from an OpenAPI/WSDL the user provides | S07, S15 | — | adapters |
| **8** | Hardening the AI | dry runs with mocked invokes, generated test data, eval suite to 50+ cases, Opus fallback on hard builds, prompt caching, per-org AI budgets | S13 | usage_hourly | dry-run |
| **9** | Product | versions, import/export, roles UI, lookups/libraries (JS in isolated-vm), metering + Stripe billing, on-prem agent (could), self-host docs | S18, S19, S25 | libraries, agent_groups | import/export, billing |

Then: should-haves and could-haves by area, then the fixes
`/replica-entrepreneur` finds.

## Implementation notes

**Phase 1 (done).** What was built, and where it differs from the plan above:

- **Engine** (`packages/engine`) is pure: adapters, persistence, email and sleep are injected. It
  supports every v1 step type except `js` (faults with `not_supported` until phase 9). `forEach`
  runs sequentially; `parallel` is accepted but not used yet. One-element JSONata sequences are
  treated as one-item arrays in loops.
- **Retries** happen only for errors the adapter marks retryable (timeouts, connection errors,
  429, 5xx), with exponential backoff from `backoffSeconds`.
- **Resumability**: each step is written as it finishes, but a crashed worker's run is not resumed
  from its last step yet. The worker's reaper marks runs stuck in `running` for over
  `STALE_RUN_MINUTES` (default 30) as failed with `worker_lost`. Resume-from-step is planned with
  resubmit in phase 6.
- **Payloads** live in Postgres (`instances.input/output`, `instance_steps.input/output`), capped
  at 64 KB (audit) or 1 MB (debug), with a truncated preview past that. With `production` tracing
  only failed steps keep payloads. Object storage (MinIO/R2) replaces this when payloads need to
  grow past that.
- **Trigger auth**: one bearer token per application integration, stored encrypted, shown and
  rotated on the integration page. Per-integration basic auth / OAuth comes later.
- **Trigger input**: `$trigger` is the request body (JSON or text), or the query for GET/DELETE.
- **Schedules**: ISO intervals (`PT15M`, minimum 1 minute) or 5-field cron in an IANA time zone.
  Missed slots are not replayed; overlapping runs are skipped unless `allowOverlap`.
- **Outbound safety**: the REST adapter blocks private, loopback and link-local addresses at connect
  time (DNS rebinding safe). `ALLOW_PRIVATE_NETWORK=true` lifts this for local development only.
- **Editing**: active integrations are read-only (deactivate first, as in OIC). Saves carry the
  definition hash and are refused if it changed meanwhile. Invalid definitions save as drafts with
  their errors listed by path.

**Phase 2 (done).** The AI builder:

- **Loop** (`packages/ai/src/loop.ts`): a hand-written streaming tool-use loop, not the SDK tool
  runner, because a conversation pauses across HTTP requests when the AI asks a question
  (`ask_user`). The paused turn's other tool results are held with the question and sent together
  with the answer, so every assistant tool call is answered in one message.
- **Model call**: `claude-opus-5-5`, adaptive thinking (summaries streamed as "Thinking…"),
  effort `high`, server-side refusal fallback (`fallbacks: "default"`), system prompt + tools cached,
  top-level automatic caching for the conversation tail. Forced `tool_choice` is not used (the
  model rejects it); the prompt steers instead. The system prompt is byte-identical for every
  request; the project, integration and date go in the first user message.
- **History is append-only**: messages are stored exactly as returned (including thinking blocks) and
  never edited, which keeps thinking blocks valid and the cache warm.
- **Tools**: list_adapters, list_connections, get_flow, infer_schema, test_expression, ask_user,
  request_connection (draft, no secrets), propose_flow. Small tools are `strict`; propose_flow
  streams its large input (`eager_input_streaming`) and is validated by the FlowDoc validator
  instead, with errors returned to the model by JSON path; after 3 failed proposals in a turn it
  is told to stop and explain. No tool can save, activate, delete or read credentials.
- **Proposals** (`ai_changes`) carry a step-level diff (added / changed / moved / removed) and the
  base hash; accepting refuses if the integration changed since (marked stale) or is active.
  Accepting a new one creates the integration with its schedule; later messages in that
  conversation edit it.
- **Not yet**: accepting part of a proposal (all or nothing for now), dry runs with generated test
  data (phase 8), AI explanations of failed runs (phase 6).
- **Tests**: the loop, tools and accept path run against Postgres with a scripted model; the request
  shape is checked against a local fake of the API; the browser e2e runs the whole flow on
  recorded turns. `packages/ai/evals` holds 12 real requests graded by checks on the proposal.
  They need an API key and have **not been run yet**.

**Phase 3 (done).** The canvas:

- **Edits are pure functions** in `packages/flow-schema/src/edit.ts` (insert, remove, move, update,
  new step per type, unique ids), shared by the canvas and anything else that edits a flow.
- **Layout** (`apps/web/src/components/canvas/layout.ts`) is our own top-to-bottom tree layout:
  lists are columns, loops/scopes/switches are frames with their columns side by side, "+" insert
  points between steps. Deterministic and unit-tested (no overlaps, children inside frames,
  every edge connects real nodes). elkjs from the plan was not needed.
- **Editor**: palette, inspector per step type with live JSONata parse errors, undo (50 steps),
  move up/down, delete, live validation with problem badges on steps (shape errors now carry the
  step id and plain wording), save with the same hash check as the JSON editor. JSON stays as a tab.
  Read-only while the integration is active.
- **Replay** on the run page: steps coloured by outcome, loop counts ("ok ×2", "1/2 failed"), steps
  that did not run dimmed; clicking a step opens its record.
- **AI proposals** can be shown on the canvas with new and changed steps highlighted.
- **Not yet**: drag and drop (moves are up/down buttons), copy/paste, collapsing containers,
  editing variables and business identifiers outside the JSON view.

**Phase 4 (done).** Every update:

- **Outbox.** `events` (bigint identity id = cursor). `recordEvent` writes the event, fans out one
  `deliveries` row per matching enabled channel (type patterns `*`, `instance.*`, exact; minimum
  severity), then `pg_notify('oicr_events')`. Emitted by integrations (created, updated,
  activated, deactivated), runs (succeeded, failed), schedules (skipped), connection tests, and
  the AI builder (question, change proposed/accepted/rejected). Emitting never fails the action.
- **Live UI.** One `LISTEN` per web process (`lib/live.ts`) fans events to browsers of the same org
  over SSE (`/api/events/stream`). The client refreshes the page when the event concerns it and
  toasts failures and AI questions. **Activity** is the feed.
- **Channels** (`packages/notify`): Slack incoming webhook, Telegram bot, email (Resend), signed
  webhook. Config is encrypted like connection secrets. The worker claims due deliveries with
  `SKIP LOCKED` on every notify and every 2 s; 5xx/429/408 retry at 1 m, 5 m, 30 m, 2 h (5 attempts),
  other 4xx fail at once. Webhooks carry `X-Webhook-Signature-V2` = hex HMAC-SHA256 of
  `"{timestamp}.{body}"` with `X-Webhook-Timestamp`, which Hermes's webhook adapter verifies
  (Generic V2), and a body with `text`, `url`, `event_type`, `severity`, `data`. Channels use the
  same SSRF guard as the REST adapter.
- **API keys** `oicr_<8 hex>_<secret>`, sha256 stored, shown once. A key acts as a developer of
  the org narrowed to its scopes (`read` always; `operate`, `build`); keys can never do admin
  things. `assertCan` checks both role and scopes.
- **Public API** `/api/v1`: events (cursor), projects, integrations, runs, activate, deactivate,
  run. **MCP server** at `/mcp` (stateless streamable HTTP, JSON responses, `@modelcontextprotocol/sdk`
  web-standard transport) mounted in the web app instead of a separate `apps/mcp`. Read tools are
  `readOnlyHint`; operate and build tools are only listed when the key has the scope. Both call the
  same `lib/ops.ts`. The AI build tools run a non-streaming turn and return the reply, question or
  proposals.
- **Hermes** (`Settings → Hermes Agent`, `docs/hermes.md`): key → MCP config → webhook route with
  `deliver_only` (every update, no tokens) → optional agent route on `instance.failed` that
  diagnoses over MCP → a polling script for hosts without a public address.
- **Not yet**: `/api/v1` CRUD for channels and keys (UI only), `usage.threshold` and resubmit
  events (phases 6 and 8), per-user notification preferences, Slack/Telegram replies back into
  the AI builder (Hermes covers this today).

**Phase 5 (done).** Mapper and lookups:

- **Mapping model** (`flow-schema/src/mapping.ts`): the mapper edits JSONata object constructors.
  `parseMapping` splits `{ "key": expr, ... }` into fields, nested objects and lists
  (`[$src.items.{ ... }]`, item fields relative to the item); `printMapping` writes them back. A
  parsed tree must print to the same JSONata AST, otherwise it is shown as code, so nothing is ever
  rewritten into something different. No separate mapping format is stored: the FlowDoc stays the
  single source of truth, and maps the AI writes open in the mapper as they are.
- **Shapes** (`shape.ts`): field trees inferred from samples (merged across samples, optional and
  nullable fields) or read from JSON Schema (http `requestSchema`, map `targetSchema`).
  `sourcesAt(doc, step)` lists what a step can read (trigger, variables, earlier steps, loop items,
  fault). Loop item samples come from evaluating the loop's list over the samples.
- **Samples**: the latest runs' trigger input and step outputs (audit/debug tracing), or pasted per
  source, stored in `integrations.samples` (outside the definition, so no hash change).
- **Mapper UI** (`components/mapper`): sources | target | functions + test, a full-screen dialog
  from map, invoke (request) and return (response) steps; click or drag to map, list rows, function
  palette, target from sample with required-field flags, code view, test pane (server-side, with
  lookups). Read-only while the integration is active.
- **Lookups** (`lookups` table, S17): domains + rows; the first domain is the key (required,
  unique). Grid editor, CSV import/export, usage list. `$lookupValue(name, from, value, to, default?)`
  in the engine (`deps.lookup`, each lookup loaded once per run), in the AI's `test_expression`
  and the mapper's test. The validator flags unknown lookup names (`unknown_lookup`) and required
  target fields that are not mapped (`required_unmapped`, a warning). Lookups used by an active
  integration cannot be deleted; used ones cannot be renamed.
- **AI**: `list_lookups` tool; the prompt asks for map expressions as object constructors with
  `targetSchema` when the target is known, so they open in the mapper. API `/api/v1/lookups` and
  MCP `list_lookups`.
- **Not yet**: drawn lines between trees (rows show the expression instead), XSLT-style
  conditional/grouping templates, project-scoped lookups, editing schemas field by field.

**AI providers (after Phase 5).** The AI builder runs on Gemini, Claude or GPT:

- One conversation format, stored as before (content blocks: text, thinking, tool_use,
  tool_result). Each provider (`packages/ai/src/providers/`) translates it to its API and back,
  so the loop, tools, prompt and evals are shared, and a conversation can even continue on another
  provider.
- What a provider needs back on later turns rides on the block as `provider_data`: Gemini's thought
  signatures (required when replaying function calls; calls from other providers get Gemini's
  documented placeholder), OpenAI's reasoning items with encrypted content (requests use
  `store: false`, so nothing is kept at OpenAI). Claude gets other providers' reasoning dropped and
  the extra fields removed.
- `AI_PROVIDER` (gemini | anthropic | openai) picks; without it, the first configured key in the
  order Gemini, Claude, GPT. Defaults: `gemini-4-argon`, `claude-opus-5-5`, `gpt-6-astra`,
  each overridable. `AI_EFFORT` maps to Gemini's thinking level, Claude's effort and OpenAI's
  reasoning effort. Errors (bad key, rate limit, 5xx) are reported the same way for all three.
- Tested per provider: translation both ways, and each SDK end to end against a local mock of its
  API (streaming, request shape, errors).
