# Platform architecture (v2)

OIC-Replica grows from a single-tenant prototype into a commercial, multi-tenant, AI-native
iPaaS for the mid-market ERP ecosystem (Oracle Fusion and EBS, NetSuite, SAP S/4HANA). This
document records the decisions, the target topology, and the order in which it is built. Phases
0–5 (see `replica/architecture.md`) are the base it builds on.

## Decisions

| # | Decision | Why | Rejected |
| --- | --- | --- | --- |
| D1 | **TypeScript on Node 22** for the whole platform, including the runtime | One FlowDoc schema, validator and expression language (JSONata, whose reference implementation is JavaScript) shared by the canvas, the AI builder and the runtime: what the AI proposes and the user approves is exactly what runs. Integration latency is dominated by downstream I/O, which Node's event loop handles well; CPU-heavy transforms in batch run on `worker_threads`. | Go for the runtime: a second implementation of the schema and of JSONata (Go ports are incomplete), and the AI/UI/runtime contract would drift. Revisit only for a measured hot path, behind the same FlowDoc contract. |
| D2 | **Control plane / data plane split.** The web app (UI, AI builder, API, MCP) never executes integrations. The data plane (stream engine, batch engine, scheduler) never imports UI code. | Rule 1. Lets the data plane scale, deploy and fail independently, and run inside a tenant's namespace. | Executing sync triggers inside Next.js (today). |
| D3 | **Credentials live in a vault, never in the primary database.** HashiCorp Vault KV v2 (or OpenBao), one path per tenant and object; the database keeps only a reference. Platform-issued tokens (trigger tokens, API keys) are stored as hashes. | Rule 2. A database dump or SQL injection yields no credentials; access is audited and revocable in Vault. | AES-GCM blobs in Postgres (today). Cloud KMS-only: kept as a later Vault-compatible backend. |
| D4 | **Pooled tenancy by default, dedicated on demand.** Pooled: one database with Postgres row-level security keyed on the tenant, per-tenant queue partitions and concurrency quotas. Dedicated: the data plane runs in a Kubernetes namespace per tenant (own workers, network policy, Vault policy), optionally its own database. | Rule 2 at mid-market prices: most tenants share infrastructure safely; regulated ones get physical separation without a different product. | Database-per-tenant for everyone: operationally heavy for the long tail. |
| D5 | **Two engines, one FlowDoc.** Stream engine for synchronous webhooks and APIs; batch engine for high-volume extracts and loads. A flow declares its mode; both run the same step semantics. | Rule 3. Different resource shapes (latency vs throughput) need different executors, not different languages. | One engine with flags: either too heavy for webhooks or unsafe for millions of rows. |
| D6 | **Semantic layer resolved at compile time.** Mappings target a Semantic Catalog (Customer.number, Invoice.date…); system bindings map technical fields (HZ_PARTIES.PARTY_NUMBER, RA_CUSTOMER_TRX_ALL.TRX_NUMBER, NetSuite `entityid`, SAP `BusinessPartner`) to it. LLM reasoning proposes bindings with evidence and confidence; people approve; approved graphs compile to plain JSONata before activation. | Rule 4 without runtime cost: no model call and no graph lookup on the hot path; every running mapping is inspectable and versioned. | LLM-in-the-loop at runtime: slow, non-deterministic, unauditable. |

## Topology

```
                 control plane                                   data plane (per tier / per tenant namespace)
 ┌──────────────────────────────────────────┐        ┌──────────────────────────────────────────────────┐
 │ web (Next.js): UI, canvas, mapper        │        │ stream engine   /t/{tenant}/{integration}        │
 │ AI builder (Gemini | Claude | GPT)       │ plans  │   stateless, sync, bounded memory per request    │
 │ public API /api/v1, MCP /mcp             ├───────►│ batch engine    chunked pipelines, worker_threads │
 │ semantic catalog + binding review        │        │ scheduler       claims due schedules              │
 └──────────────┬───────────────────────────┘        └───────┬──────────────────────┬───────────────────┘
                │                                            │                      │
        ┌───────▼────────┐   ┌────────────────┐   ┌──────────▼─────┐   ┌────────────▼──────────┐
        │ Postgres (RLS) │   │ Vault (KV v2)  │◄──┤ secrets by ref │   │ ERP / SaaS endpoints  │
        │ plans, runs,   │   │ tenants/{id}/… │   └────────────────┘   └───────────────────────┘
        │ events, catalog│   └────────────────┘
        └────────────────┘          OpenTelemetry traces from every component → OTLP collector
```

- **Execution plan.** Activation compiles a FlowDoc (semantic references resolved, expressions
  pre-parsed, connections pinned) into an immutable, hashed plan. The data plane loads plans by
  `(tenant, integration, version)` and caches them; it needs nothing else from the control plane.
- **Statelessness.** Engines keep no session state. Run state is persisted per step (stream: at
  the end for sync calls; batch: per chunk checkpoint), so any replica can resume any run.

## Multi-tenancy

| layer | pooled | dedicated |
| --- | --- | --- |
| data | Postgres RLS: every tenant table has `org_id`; each request runs in a transaction with `app.tenant_id` set; policies `USING (org_id = current_setting('app.tenant_id')::uuid)`; app role has no `BYPASSRLS` | own schema or database |
| events | queue partition per tenant (`run.{tenant}`), per-tenant concurrency and rate quotas, fair scheduling across tenants | own workers |
| execution | shared workers, per-run memory/time budgets, JS library steps in `isolated-vm` | own Kubernetes namespace, NetworkPolicy, resource quotas |
| secrets | Vault path `tenants/{id}/…`, platform policy scoped to that prefix | own Vault namespace (Enterprise/HCP) and policy |
| observability | `oicr.tenant_id` on every span, log and metric | same, plus tenant-scoped exports |

## Secrets (D3)

- `SecretStore` (`packages/vault`): `put / get / delete` by `{ tenant, kind, id }`. Backends:
  - `vault`: KV v2 at `{mount}/data/tenants/{tenant}/{kind}/{id}`; auth by token, AppRole or
    Kubernetes service account; tokens renewed before expiry and re-acquired on 403; every call
    retried with backoff on 5xx/429/network errors and traced.
  - `database`: AES-GCM in a separate table, for local development and tests only. Refused when
    `NODE_ENV=production`.
- Reads go through a short-TTL in-process cache (default 60 s, `VAULT_CACHE_TTL_MS`) so the
  stream engine does not pay a Vault round trip per request; writes invalidate it.
- Rotation: a credential update writes a new KV version; runs pick it up within the cache TTL.
  `scripts/migrate-secrets` moves pre-v2 ciphertexts from Postgres into the store.

## Dual-engine runtime (D5)

**Stream engine** (`apps/stream`): a small HTTP service for sync triggers.
- Budgets per request: body size limit, total deadline, step limit; no buffering beyond the body.
- Hot path: token check by hash (no Vault call), cached plan, cached credentials, pooled HTTP
  agents per connection; target overhead p99 < 5 ms excluding downstream calls.
- Async triggers return 202 after persisting the run and enqueueing it.

**Batch engine** (`apps/batch`): pipelines built from async iterators (built in P4 for
databases; see the P4 notes).
- `source` (paged API reads, database keyset pages, files) → `chunk(n)` → `transform` (JSONata on a
  `worker_threads` pool) → `sink` (bulk APIs: Fusion REST batch / FBDI, NetSuite SuiteTalk async,
  SAP OData `$batch`, database `COPY`/multi-row insert).
- Memory is bounded by `chunkSize × concurrency`; backpressure comes from awaiting the sink.
- Each chunk is checkpointed (cursor + counts); a crashed run resumes from the last checkpoint.
  Sinks are idempotent by key, so a replayed chunk does not duplicate rows.
- Per-row errors go to a reject stream (the errors list), not a failed run, up to a threshold.

## Semantic layer (D6)

- **Catalog**: entities (Customer, Supplier, Item, SalesOrder, Invoice, Payment, Journal…),
  attributes with types, identifiers and relationships. Versioned, with tenant extensions.
- **System bindings**: for each system type and version, technical object/field → attribute,
  with transforms (e.g. `HZ_CUST_ACCOUNTS.ACCOUNT_NUMBER → Customer.accountNumber`,
  `PO_HEADERS_ALL.SEGMENT1 → PurchaseOrder.number`, `MTL_SYSTEM_ITEMS_B.SEGMENT1 → Item.number`).
- **AI reasoning**: given a schema sample (columns, types, sample values, descriptions), the
  model proposes bindings with evidence and a confidence; low-confidence or conflicting bindings
  wait for a person. Accepted bindings become part of the tenant's graph.
- **Use**: `$toSemantic(records, system, object)` reads technical records as catalog entities,
  `$fromSemantic` writes them back in a system's fields and formats, and `$translate` derives
  system-to-system maps through the catalog (source binding ∘ inverse target binding). Compiled
  into the execution plan at activation (see P3 notes).

## Reliability and observability

- **Retry policy** (`packages/platform`): exponential backoff with full jitter, capped delay,
  overall deadline, `Retry-After` honoured, retryable-error classification, abort signals. Used
  by connection calls, Vault, notifications and AI calls.
- **Circuit breaker** per connection (planned with the stream engine) so one failing ERP does not
  exhaust workers.
- **Tracing**: OpenTelemetry spans on every execution block: run, step, connection call, Vault
  operation, notification delivery, AI turn; attributes include tenant, integration, version, run
  and step ids. Trace context flows from the HTTP trigger through the queue to the worker.
  Exported over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; no-op otherwise.

## P1 notes (done)

- `packages/platform`: `retry()` (attempts, exponential backoff with equal/full jitter, cap,
  deadline, Retry-After, abort, transient-error classification), `withSpan` and context
  propagation helpers on the OpenTelemetry API, and `startTelemetry` (OTel SDK 3.0, OTLP/HTTP,
  parent-based ratio sampling, W3C trace context + baggage).
- Spans: `http trigger` (server, continues the caller's `traceparent`, returns `x-trace-id`),
  `schedule fire`, `integration execute` (continues the trace from the queued job), `flow run`,
  `step <type>`, `retry wait`, `HTTP <method>` (no query string recorded), `vault read|write|delete`,
  `notify deliver`, `ai message`, `ai model turn` (provider, model, tokens), `ai tool <name>`.
  Tenant, integration, version and run ids are attributes. Verified: one trace from an HTTP call
  through the queue to the worker's steps.
- Engine retries use the shared backoff with jitter and honour Retry-After (REST adapter parses
  it on 429/503, capped at 10 minutes).
- `packages/vault`: KV v2 store at `{mount}/data/tenants/{tenant}/{kind}/{id}`; token, AppRole
  and Kubernetes auth; renewal before expiry; re-login on 403; retries; cache with
  single-flight reads. Tested against a real Vault: per-tenant storage, versions, policy
  confinement, revocation recovery.
- Credentials moved out of Postgres: connections keep `has_secret`, channels a masked `target`;
  trigger tokens are sha256 hashes shown once. `migrate` moves pre-v2 ciphertexts into the store
  (store first, then empties the column; undecryptable rows are left in place and reported).
  The legacy columns are dropped in P2. A `pg_dump` after creating credentials contains none of
  them.
- docker compose bundles Vault (file storage, auto init/unseal, `oicr-platform` policy, periodic
  token shared through a volume). The `database` backend is development-only and refused in
  production. CI and the e2e suite run against a real Vault dev server.
- Not yet: deleting a whole tenant's secrets on offboarding (needs a recursive KV list; P2 with
  tenant lifecycle), per-tenant Vault namespaces for the dedicated tier.

## P2a notes (done): tenant isolation in the database

- Migration 0006: `org_id` added to the child tables that lacked it (`instance_steps`,
  `ai_messages`, `deliveries`, backfilled from their parents); every tenant table (and
  `dev_secrets`) has `ENABLE` + `FORCE ROW LEVEL SECURITY` and one policy,
  `oicr_can_access(org_id)`: the row's tenant must equal the transaction's `app.tenant_id`, or
  `app.bypass_rls` must be on. Unset means no rows: reads return nothing, writes are rejected.
- `packages/db/src/tenancy.ts`: `asTenant(db, tenant, fn)` (a short transaction with the tenant
  set; nested calls for the same tenant join it, another tenant is refused), `asSystem(db,
  reason, fn)` for the platform's cross-tenant jobs only (claiming due schedules, deliveries
  and queued runs, routing a trigger URL, checking an API key, reaping stale runs, migrating
  legacy secrets, offboarding), and `refuse(error)` for "record it, then refuse" paths (a stale
  AI proposal, validation errors on activation) whose writes must commit. Every repository
  function runs in one of them; external calls (connection tests, Vault) happen outside long
  transactions.
- Roles: policies only bind roles without superuser/BYPASSRLS, and `FORCE` makes them bind the
  table owner too. docker compose runs migrations and the job queue as the owner and the web app
  and worker as `oicr_app` (created by the migration when it may, given a login with
  `APP_DB_PASSWORD`). The web app and worker check their role at start and refuse to run in
  production when isolation would not apply. Migrations connect with `app.bypass_rls=on` to
  backfill. pg-boss uses `QUEUE_DATABASE_URL` (it owns its schema; jobs hold run ids only).
- The settings are transaction-local, so pooled connections never leak a tenant. They protect
  against application bugs (a missing `WHERE org_id`), not SQL injection; queries stay
  parameterised.
- Offboarding: `offboardTenant` (and `node packages/db/dist/offboard.js <org>`) deletes the
  tenant's Vault secrets (recursive KV list + delete; the platform policy gains `list` on
  `metadata/tenants/*`), then the organization row, which cascades to all tenant data.
- Verified: an isolation test suite (no-WHERE reads, unscoped reads/writes, cross-tenant writes,
  mixed scopes, refusals); the whole unit and e2e suites run under enforced RLS; in docker
  compose a second tenant gets 404 on the first tenant's connection URL, and `oicr_app` sees 0
  rows unscoped and is refused when inserting into another tenant.
- Kept for one more release: the emptied legacy ciphertext columns, so installs upgrading from
  before P1 still have their credentials moved by `migrate` before the columns go.

## P2b notes (done): stream engine, plans, per-tenant limits

- `apps/stream`: a plain `node:http` service that owns `/t/{org}/{identifier}/…`. It keeps no
  state between requests: routes come from a cache (single-flight loads, short TTLs, a shorter
  one for misses) that every instance drops on `NOTIFY oicr_routes`, sent when an integration is
  activated or deactivated or its token is replaced. Sync triggers run inline and answer with
  the flow's response; async triggers queue the run and answer 202. Bodies are capped (413), each
  tenant has a request rate and a concurrent-request cap from its tier (429 with `Retry-After`),
  and there is a process-wide in-flight cap. Every request is a server span; the trace id is
  returned in `x-trace-id` when tracing is on. `/healthz` and `/readyz` (database reachable) for
  orchestrators; SIGTERM stops accepting and drains in-flight requests.
- The web app's `/t/…` route only forwards to `STREAM_URL`, so existing trigger URLs keep
  working; production ingress can send `/t/` to the stream engine directly.
- Execution plans (migration 0007, `integration_plans`): activation stores an immutable copy of
  the validated definition and tracing level; the integration points at it (`active_plan_id`)
  and each run records the plan it was created with, so editing or re-activating never changes
  a run in flight. Runs from before plans existed fall back to the definition.
- Per-tenant limits (`tenant_limits`: tier, sync concurrency, requests per second; defaults per
  tier from `TIER_*`). Async runs are queued with the tenant as the pg-boss group, and workers cap
  each group's concurrent runs by tier, so one busy tenant cannot starve the others.
- Circuit breakers in the runtime, per tenant and connection: after `BREAKER_FAILURES`
  consecutive retryable failures calls are refused for `BREAKER_OPEN_SECONDS`, then one probe
  is let through. Refusals are retryable step faults with a retry delay; an opening raises a
  `connection.circuit_open` event.
- Verified: unit tests for the route cache, limits, drain and breaker; the e2e suite runs
  through the stream engine; in docker compose a trigger on the web address is proxied to the
  stream service, queued, run by the worker on its plan, and a bad token gets 401.

## P3 notes (done): semantic catalog

- `packages/semantic`: the platform catalog (`CATALOG_VERSION` 2026.10, nine entities with typed
  attributes, identifiers, references and synonyms) and platform bindings for Oracle Fusion REST
  resources, Oracle EBS tables, NetSuite REST records and SAP S/4HANA OData V2 entities. Each
  system has a dialect (EBS: Y/N flags; SAP: `/Date(ms)/` dates). `SemanticGraph` applies a
  workspace's layer on top: added attributes and entities, objects of any system, rebound or
  switched-off fields; one field per attribute per object, the workspace's winning.
- Workspace layer (migration 0008, all under RLS): `semantic_entities`, `semantic_objects`,
  `semantic_bindings` (one row per field; `attribute` null switches a platform binding off) and
  `semantic_proposals` (AI proposals with per-item decisions; field names and types only, never
  sample values). A test fails if any table with `org_id` lacks forced RLS.
- Use: `$toSemantic`, `$fromSemantic`, `$translate` with literal system and object names. The
  validator checks them against bound objects on save; activation compiles the objects a flow
  uses into a `SemanticPlan` (fields, transforms, attribute types, dialect, per-object hashes)
  stored on the execution plan, and plan reuse includes its hash. The runtime builds the JSONata
  functions from the plan (cached per plan id): no catalog lookup or model call on the hot path.
  Reading normalises values to the catalog's form; writing renders the target dialect; read-only
  fields are never written. `semanticDrift` compares a plan's object hashes with the current
  graph so the integration page can say when bindings changed; running plans are untouched.
- AI discovery (`packages/ai/src/semantic.ts`): a pasted sample (JSON, API envelopes such as
  OData `d.results`, CSV, or column lists) is reduced to fields with types and up to three
  shortened example values (optional). The model answers through one `submit_bindings` tool;
  `checkProposal` refuses unknown entities, attributes and fields, invalid transforms and
  duplicate attributes, and the model gets one correction round with the reasons. Items at or
  above 0.9 confidence (with entity confidence ≥ 0.9) that do not conflict with current bindings
  apply automatically (recorded with no approver); the rest wait for review, where people
  approve, correct the attribute or reject. Approval replaces a conflicting binding. Traced as
  `ai propose_bindings`; transient provider errors are retried with backoff.
- The AI builder has a `semantic_catalog` tool and its prompt prefers the functions for
  ERP-to-ERP flows; `test_expression` and the mapper's test pane compile semantic calls from the
  current graph so they can be tried before activation. Read access: `GET /api/v1/catalog`, MCP
  `semantic_catalog`.
- Verified: unit tests for platform bindings, graph overrides, compile, drift, runtime read and
  write per dialect, sample parsing and proposal checks; database tests for isolation, binding
  checks, auto-approval and conflicts, plan compilation, drift and plan reuse; a runtime test
  translating EBS to NetSuite on a pinned plan; AI tests with a scripted model; an e2e test
  that binds a system with AI, reviews it, translates in a sync integration and sees drift; in
  docker compose an SAP sales order posted to the trigger URL comes back as EBS columns.
- Not yet: line-level objects (order and invoice lines), relationships resolved across objects
  (a reference holds the other entity's number, which the flow must supply), and a catalog
  version upgrade path for workspace layers.

## P4 notes (done): batch engine and database adapter

- **Database adapter** (`packages/adapters/src/database`): PostgreSQL (postgres.js), MySQL
  (mysql2) and Oracle (node-oracledb in thin mode: no Instant Client, works for EBS). Pooled
  per connection settings, idle pools closed. Hosts are resolved and checked against the
  private-network rule before connecting. Parameters are `:name`, always bound (a tokenizer
  skips strings, comments and casts); identifiers are checked against a strict pattern rather
  than quoted, so each database keeps its case rules. Oracle sessions use ISO date formats and
  UTC. Errors are classified (auth, connection, deadlock and serialization retryable; SQL
  errors with SQLSTATE / ORA numbers not).
  - Step operations: `query` (capped at `maxRows`), `execute`, `insert`, `upsert`.
  - Batch reads: keyset pagination on a unique, sortable `key`
    (`SELECT q.* FROM (<query>) q WHERE q.key > :after ORDER BY q.key LIMIT n`, `FETCH FIRST`
    on Oracle); each page is its own short query, and the cursor is the last key.
  - Batch writes: multi-row `INSERT … ON CONFLICT DO UPDATE` (Postgres), `ON DUPLICATE KEY
    UPDATE` (MySQL), `MERGE` through `executeMany` with batch errors (Oracle), in one
    transaction per chunk (statements split under the bind limit). When a chunk fails for a
    non-retryable reason it is rolled back and written row by row, so good rows land and bad
    rows are named.
- **Pipeline step** (FlowDoc): source (connection, operation `read`, config, `params`
  evaluated once), optional per-record `filter` and `transform` (`$record`; `$translate`,
  `$lookupValue`, `$trigger` and earlier outputs work), target (`insert` / `upsert`),
  `chunkSize`, `concurrency`, `maxRejects`. Validation refuses pipelines in sync flows and in
  loops, non-batch connections or operations, and (via the adapter) bad source/target
  configuration, at save time. Its output is counts only.
- **`packages/batch`**: `runPipeline` reads only when a slot is free (at most `concurrency`
  chunks in flight), retries retryable writes with backoff, commits rejects and checkpoints
  strictly in chunk order, fails past `maxRejects`, and stops on abort. Transforms run on a
  `worker_threads` pool: expressions compiled once per worker, lookups preloaded, the plan's
  semantic bindings included, a heap limit per worker, a per-chunk timeout that replaces a
  runaway worker.
- **Lanes and resume** (migration 0009): runs of flows with a pipeline are on the `batch` lane
  and queue to `run-batch`, consumed by `apps/batch` (the standard worker never runs them;
  elsewhere the step fails with `batch_engine_required`). `pipeline_checkpoints` keeps the
  cursor and counts per run and step; `pipeline_rejects` the set-aside records (shortened,
  first 10 000 per step). Batch runs heartbeat; `requeueStaleBatchRuns` puts quiet runs back
  on the queue (attempts + 1) and fails them after `BATCH_MAX_ATTEMPTS`. A resumed run replays
  the steps before the pipeline, skips a pipeline already done, and continues an unfinished one
  after its last checkpoint; upserts make the replayed chunk harmless. On SIGTERM the engine
  stops taking runs, waits `BATCH_DRAIN_SECONDS`, and leaves the rest to resume.
- UI: database connections (adapter picker), a pipeline inspector on the canvas, and pipeline
  progress plus rejected records on the run page. The AI builder knows when to use a pipeline.
- Verified: live adapter tests on PostgreSQL 16, MySQL 8.4 and Oracle 23ai (chunked loads,
  keyset reads and resume, idempotent upserts with row-level rejects, query caps); pipeline
  runner and worker-pool tests; a runtime test loading Postgres into MySQL through worker
  threads with lookups, filters, a rejected row, resume from a checkpoint and stale-run requeue;
  an e2e test from creating the connection to the run page; and in docker compose a
  1 000 000-row load whose batch engine was killed at 558 000 rows: it resumed (attempt 2) and
  finished with exactly 1 000 000 correct rows, the engine using 160–230 MB throughout.
- Not yet: composite keys for reads, file and API sources (SFTP, paged REST, Fusion/NetSuite/SAP
  bulk APIs come with P5), `COPY`-based Postgres loads, and running a pipeline across several
  engines at once.

## Build order

| step | delivers |
| --- | --- |
| **P1 Trust foundations** ✅ | `packages/platform` (retry policy, tracing helpers, OTel bootstrap); tracing on every execution block; `packages/vault` (Vault KV v2 + dev backend); connection credentials and channel configs moved to the store; trigger tokens hashed; Vault in docker compose; migration of existing secrets |
| **P2 Stream engine + tenant isolation** ✅ | `apps/stream` service owning `/t/…`; execution plans; Postgres RLS; per-tenant queues, quotas and fair scheduling; circuit breakers |
| **P3 Semantic catalog** ✅ | catalog and bindings model, seed bindings for Fusion, EBS, NetSuite, SAP; AI binding proposals with review; `$toSemantic` / `$fromSemantic` / `$translate`; compile at activation |
| **P4 Batch engine** ✅ | pipeline runtime, worker-thread transforms, checkpoints, reject stream; database adapter (Postgres, Oracle, MySQL) |
| P5 ERP connectors | Oracle Fusion REST + FBDI, NetSuite REST/SuiteTalk, SAP OData; their bulk paths for the batch engine |
| P6 Operations | errors list with resubmit, dashboards on the traces and run data, AI failure explanations |
