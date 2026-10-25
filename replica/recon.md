# Recon map: Oracle Integration 3 (web)

Scope: an AI-first integration builder on top of the core integration engine. Plain-English chat that builds flows, plus projects, connections, a starter set of
adapters (REST, SOAP, FTP/SFTP, database, scheduled), the visual orchestration
canvas, the mapper, lookups, JavaScript libraries, activation, and
observability (instances, activity stream, errors, resubmit).
For: a product to sell. An iPaaS you own and can change, aimed at a niche
(see "Positioning hints" at the bottom; replica-entrepreneur decides it).
Date: 2026-10-25
Method: public sources only. No OIC account was used. Oracle's cloud terms may
limit using a subscription to build a competing product, so stay on public
docs, blogs and videos. Screenshots in `replica/screens/` should come from
public docs and videos, and they are reference only.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | docs: integration styles | https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/understand-integration-styles.html | application (was app-driven), scheduled, basic routing, file transfer |
| 2 | docs: scheduled integration | https://docs.oracle.com/en/cloud/paas/integration-cloud/integrations-user/create-scheduled-integration.html | the schedule is the trigger |
| 3 | docs: triggers, invokes, actions | https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/define-inbound-triggers-and-outbound-invokes.html | the canvas action list |
| 4 | docs: add actions | https://docs.oracle.com/en/cloud/paas/integration-cloud/integrations-user/add-actions-app-driven-orchestration-integration.html | switch, for-each, while, scope, assign, stitch, logger, notification, fault actions |
| 5 | docs: canvas expand/collapse | https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/expand-and-collapse-actions-integration-canvas.html | canvas behaviour |
| 6 | docs: cut and paste on canvas | https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/cut-and-paste-elements.html | canvas editing |
| 7 | docs: navigation pane | https://docs.oracle.com/en/cloud/paas/application-integration/int-get-started/navigate-oracle-integration.html | top-level nav |
| 8 | docs: resubmit failed messages | https://docs.oracle.com/en/cloud/paas/application-integration/integrations-user/resubmit-failed-messages.html | resubmit creates a new tracked run |
| 9 | docs: manage errors | https://docs.oracle.com/en/cloud/paas/integration-cloud/integrations-user/manage-errors.html | filters, discard, resubmit, payload |
| 10 | docs: business identifiers | https://docs.oracle.com/cloud-machine/latest/intcs_gs/ICSUG/GUID-02C9A46A-9069-464B-A9CC-A2995A0E14D5.htm | primary + secondary tracking fields |
| 11 | docs: create a connection (adapter guides) | https://docs.oracle.com/en/cloud/paas/application-integration/snowflake-adapter/create-connection.html | per-adapter connection form, security policy, test |
| 12 | docs: connections (DACS guide) | https://docs.oracle.com/en/industries/energy-water/cloud-integrations/24b/dacs-derms-configuration-guide/DACS-DERMS-CONFIGURATION-GUIDE/DACS-DRMS_Config_Guide_Import-Configure-Test_Connections.07.4.html | trigger vs invoke roles, test before save |
| 13 | docs: service limits | https://docs.oracle.com/en-us/iaas/application-integration/doc/service-limits.html | payload and timeout limits |
| 14 | docs: troubleshoot runtime | https://docs.oracle.com/en/cloud/paas/integration-cloud/integrations-user/troubleshoot-integration-runtime.html | 300 s sync limit |
| 15 | docs: user guide TOC | https://oracle.hydrogen.sagittarius.connect.product.adaptavist.com/en/cloud/paas/application-integration/integrations-user/toc.htm | full feature list mirror |
| 16 | public REST API | https://docs.oracle.com/cloud-machine/latest/intcs_gs/ICSRA/rest-endpoints.html | /integrations, /connections, /lookups, /monitoring: data model hints |
| 17 | REST API listing | https://apis.io/apis/oracle-integration/oracle-integration-connections-api/ | connections API |
| 18 | blog: Gen3 projects | https://appsassociates.com/blog/oracle-integration-cloud-gen3-projects-features-limitations-and-advantages | project limits (Feb 2024, may be stale) |
| 19 | blog: observability | https://www.techsupper.com/2022/12/observability-run-time-monitoring-in-oracle-integration/ | dashboards, instances, errors (third party) |
| 20 | pricing analysis | https://automationatlas.io/answers/oracle-integration-cloud-pricing-explained-2026/ | Standard vs Enterprise, messages/hour (third party) |
| 21 | licensing analysis | https://redresscompliance.com/oracle-integration-cloud-licensing.html | 5,000 msgs/hr packs, hourly billing floor (third party) |
| 22 | what's new 26.07 | https://blogs.oracle.com/oracle4engineer/ja-whats-new-oracle-integration-2607-2 | AI assistant, best-practice checks |
| 23 | Gen 2 end of life | https://docs.oracle.com/en/cloud/paas/application-integration/whats-new/end-life-oracle-integration-generation-2.html | Gen 2 discontinued Aug 2025 |

Note: docs.oracle.com could not be fetched directly from this environment, so
these pages were read through search excerpts. Re-read 3, 4, 9 and 13 in a
browser before replica-architect locks the action set and limits.

## Core loop

**Original (OIC):** connect two systems, draw a flow between them on a canvas
by hand, map the data, activate it, and watch every run (with the payload) so
failed ones can be fixed and resubmitted.

**Clone (the extension):** describe the integration in plain English in a chat
panel. The AI asks what it needs to know, builds the flow, connections and maps
as a draft, and shows it on the canvas for review. A human approves and
activates. Monitoring stays the same, with AI that explains failures. The
manual canvas and mapper stay as the place to review and fine-tune. They are
no longer the only way to build.

Note: Oracle is moving here too. OIC 26.07 (source 22) added AI assistant
improvements and AI best-practice checks. The gap to own is the full build
from English: flow, connections, maps, tests and edits, end to end.
replica-entrepreneur should confirm how far Oracle's assistant goes today.

## Screens

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Home | / after sign in | entry point, recent items, quick create | nav pane, cards, recent list | empty (new tenant), filled |
| S02 | Projects list | Design > Projects | all projects | table, search, create button, filters | empty, filled, loading |
| S03 | Project workspace | open a project | one place for a project's integrations, connections, lookups, libraries, deployments, observe tab | tabs or sections, per-type tables, add buttons | empty project, filled, read-only (shared) |
| S04 | Integrations list | Design > Integrations, or inside S03 | list integrations with status and version | table, status badge (draft / configured / active / failed), row actions menu | empty, filled, activation in progress, activation failed |
| S05 | Create integration dialog | Create on S04 | pick a style and name it | modal, style cards (application, scheduled), name, identifier, version, description | default, validation error (identifier taken) |
| S06 | Integration canvas | open an integration | draw the flow | canvas, trigger node, invoke nodes, action nodes, "+" insert points, side palette, zoom, expand/collapse, cut/paste, errors panel, save, close | new (trigger only), filled, invalid (red badges), read-only (active), locked by another user |
| S07 | Adapter endpoint wizard | drop a connection onto the canvas as trigger or invoke | configure an operation: e.g. REST resource, verb, request/response schema | multi-step wizard, sample JSON / schema upload, summary step | each step, validation error, schema parse error |
| S08 | Mapper | click a map node on S06 | map source fields to target fields | two trees (sources / target), drag lines, function palette, expression editor, test pane, XSLT code view | empty map, partial, complete, error (required target unmapped) |
| S09 | Expression builder | from assign, switch, while, mapper | write XPath-style expressions | tree of variables, function list, text editor, validate | valid, invalid |
| S10 | Schedule editor | scheduled integrations, "Schedule" action | define when it runs | simple (every N minutes/hours/days) and iCal/advanced, start/end, time zone | none, active, paused |
| S11 | Business identifiers panel | canvas toolbar | choose fields to track runs by | field tree, primary / secondary picker (up to 3) | none set (blocks activation), set |
| S12 | Activate dialog | row action on S04 | turn it on | tracing level (production / audit / debug), payload logging toggle, warnings | ready, blocked (errors listed), activating, failed |
| S13 | Integration run / test page | app-driven REST trigger, "Run" on S04 | send a test request and see the response | request builder (headers, body), response pane, link to instance | idle, running, success, fault |
| S14 | Connections list | Design > Connections | all connections | table, adapter icon, role, status, test button | empty, filled, test failed |
| S15 | Create connection: adapter picker | Create on S14 | choose an adapter | searchable grid of adapters, categories | filled, no results |
| S16 | Connection editor | after S15, or open a connection | configure endpoint, security, agent group, role | form sections: properties, security policy (basic, OAuth client credentials, OAuth auth code, API key, none), agent group, test, save | draft, testing, success (configured), failed (with message), in use (edit warning) |
| S17 | Lookups list + editor | Design > Lookups | value maps between systems (e.g. country codes) | grid with domain columns, add row/column, CSV import/export | empty, filled, duplicate key error |
| S18 | Libraries list + editor | Design > Libraries | upload JavaScript functions usable in maps and actions | file upload, function list, parameter types | empty, filled, invalid file |
| S19 | Agents | Design > Agents | on-premises connectivity agent groups | table, agent status, download installer, last heartbeat | none, online, offline |
| S20 | Observability dashboard | Observability > Dashboard | health at a glance | counters (received, processed, succeeded, errored), charts by time window, top failing integrations | no data, filled |
| S21 | Instances list | Observability > Instances | find runs | table with business identifier values, status, start time, duration, filters (time, integration, status, identifier search) | empty, filled, filtered empty |
| S22 | Instance detail / activity stream | open an instance | see what happened, step by step | flow diagram with path highlighted, activity stream list, payload viewer per step, error banner | running, succeeded, failed, aborted, payload hidden (tracing off) |
| S23 | Errors list | Observability > Errors | triage failures | table grouped by integration, error type, recoverable flag, bulk select, resubmit, discard | none, filled, resubmitting, partially resubmitted |
| S24 | Integration-level stats | Observability > Integrations | per-integration counts | table, sparkline, drill to S21 filtered | filled |
| S25 | Import / export | row actions on S02, S04 | move work between instances | file picker (archive), conflict prompt, connection reconfiguration prompt | success, conflict, missing connections |
| S26 | Settings | Settings | tenant settings | notifications email, certificates (upload trust certs), API keys, users and roles | defaults, edited |
| S27 | Users and roles | Settings > Access | who can design vs monitor | table, role picker (admin, developer, monitor, viewer) | single user, filled |

| S28 | AI builder chat (clone-only) | "Build with AI" on S01, S03, S04; docked panel on S06 | describe an integration in English; answer clarifying questions; review proposed changes | chat thread, suggested prompts, clarifying-question cards (choices), plan summary card (systems, trigger, steps, maps), "connections needed" checklist with links to S16, change diff (added / changed / removed nodes), Apply / Discard / Edit, dry-run result | empty (prompts), thinking, asking, proposal ready, applied, validation failed (AI output rejected and retried), needs credentials, error |
| S29 | AI change review (clone-only) | Apply on S28 | see exactly what the AI changed before it lands | canvas with highlighted new/changed nodes, map diff, accept all / accept per node / reject | pending, partially accepted, accepted |

29 screens (27 from OIC, 2 clone-only). All web; OIC has no mobile app.

## Flows

```
F01 Build and activate a REST-to-REST integration (the core loop)
    S02 create project -> S03 -> S14/S15/S16 create REST connection (trigger role), test
    -> S16 create second REST connection (invoke role), test
    -> S05 create application integration -> S06 add trigger -> S07 configure resource + JSON sample
    -> S06 add invoke -> S07 configure target endpoint -> S08 map request -> S08 map response
    -> S11 set business identifier -> S12 activate -> S13 test run -> S22 view instance
    happy path clicks: ~45 (the number to beat)
    edge: schema sample invalid, required target field unmapped, connection test fails,
          endpoint identifier already exists, activation fails, target returns 500,
          sync call over 300 s timeout

F10 Build an integration from English (clone core loop, replaces F01 for most users)
    S28 "Every 15 minutes, take new orders from our Postgres orders table and POST them
         to the Shopify-style REST API at api.example.com; email me if one fails"
    -> AI asks: which table/columns, what counts as "new", target endpoint and auth type
    -> AI shows plan: scheduled trigger, DB invoke, for-each, map, REST invoke, scope + fault -> email
    -> "connections needed": user fills credentials in S16 (never in chat), tests
    -> AI generates maps from table schema + target sample -> S29 review diff -> accept
    -> AI dry run with generated test data -> S12 human activates -> S21 watch runs
    happy path clicks: target ~10 plus typing (vs ~35-45 manually in OIC)
    edge: ambiguous request, a system with no adapter, AI proposes an invalid flow
          (schema validator rejects it, AI retries), field it cannot map (left for the
          user, flagged), user edits the canvas by hand and then asks the AI for more
          changes (AI must work from the current definition), prompt asks for secrets

F11 Change a flow by instruction (clone)
    S06 docked S28: "add a retry 3 times on the REST call and skip orders under $5"
    -> S29 diff -> accept -> S12 re-activate (new version)
    happy path clicks: ~4
    edge: the change conflicts with an active version, the instruction is unclear

F12 Ask why a run failed (clone)
    S22 "Explain" -> AI reads the activity stream and error -> plain-English cause
    -> proposed fix as a S29 diff, or "fix the data and resubmit"
    edge: payload not logged (tracing level), failure is in the external system

F02 Build a scheduled integration (poll and push)
    S05 scheduled -> S06 invoke DB/FTP to read -> for-each -> invoke REST to write
    -> S08 maps -> S12 activate -> S10 set schedule -> S20/S21 watch runs
    happy path clicks: ~35
    edge: overlapping runs (previous still running), zero records, partial batch failure,
          time zone and DST change, schedule paused while running

F03 Add branching and error handling
    S06 add switch with routing expression (S09) -> otherwise branch
    -> wrap invoke in scope -> add fault handler -> throw new fault / logger / notification email
    happy path clicks: ~15
    edge: no branch matches, nested scope fault, re-throw to global fault handler

F04 Investigate and resubmit a failed run
    S20 dashboard (errored count) -> S23 errors -> filter by integration -> open S22
    -> inspect failing step payload -> fix connection or data -> back to S23 -> resubmit
    -> S22 new run tracked separately
    happy path clicks: ~8
    edge: error not recoverable (sync / trigger-side), bulk resubmit of 500, payload not
          logged because tracing was production level, resubmit fails again

F05 Find a run by business value
    S21 search "order 10045" -> S22
    happy path clicks: 3
    edge: no identifier set on that integration, identifier on many runs

F06 Maintain a lookup used by maps
    S17 create lookup with two domains -> add rows or import CSV -> S08 use lookupValue() in map
    happy path clicks: ~10
    edge: duplicate key, missing value at runtime (default), lookup in use by active integration

F07 Change an active integration
    S04 deactivate (or create new version) -> S06 edit -> S12 reactivate
    happy path clicks: ~6
    edge: versioning (1.0 -> 1.1 active side by side vs replace), in-flight instances

F08 Promote between environments
    S25 export project from dev -> import into prod -> S16 re-enter connection credentials -> S12 activate
    happy path clicks: ~10
    edge: connection missing, identifier conflict, different adapter version

F09 Use an on-premises system through an agent
    S19 create agent group -> download/install agent -> heartbeat online
    -> S16 connection with agent group -> test
    edge: agent offline mid-run, firewall, 50 MB payload limit on agent path
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Button | primary, secondary, ghost, danger, icon | default, hover, focus, disabled, loading | all |
| Nav pane | collapsed, expanded | active section | all |
| Data table | sortable, selectable rows, row actions menu | empty, loading, filled, error | S02, S04, S14, S17, S18, S19, S21, S23, S24 |
| Status badge | draft, configured, active, activating, failed, succeeded, running, errored, aborted | — | S04, S14, S21, S22, S23 |
| Filter bar | time window, multi-select, free text | applied, cleared | S04, S14, S21, S23 |
| Modal / dialog | small form, confirm, destructive confirm | open, submitting, error | S05, S12, S25 |
| Wizard | linear steps with summary | per-step valid / invalid | S07, S16 |
| Canvas | vertical flow, nested blocks (scope, switch, loop) | edit, read-only, zoom, collapsed nodes, error badges | S06, S22 (read-only) |
| Canvas node | trigger, invoke, map, assign, switch, for-each, while, scope, fault handler, logger, notification, stitch, wait, stop, JS call | default, selected, invalid, executed (in S22), failed | S06, S22 |
| Insert point "+" | between nodes, inside branch | hover, menu open | S06 |
| Action palette | search, grouped | — | S06 |
| Schema tree | source (multi-root), target | expanded, mapped, required-unmapped | S08, S09, S11 |
| Mapping line | direct, via function | selected, invalid | S08 |
| Expression editor | inline, full | valid, invalid | S08, S09, switch / while / assign |
| Code view | XSLT, JSON, XML | read-only, editable | S08, S22 |
| Payload viewer | JSON, XML, text, binary download | pretty, raw, truncated | S13, S22 |
| Activity stream | timeline list | step ok, step failed, collapsed loop iterations | S22 |
| Key-value grid | editable cells | dirty, error | S17 |
| Schedule picker | simple, advanced (iCal) | — | S10 |
| Security policy form | basic, OAuth client credentials, OAuth auth code (+ consent), API key, none | — | S16 |
| Counter tile + chart | count, percentage, time series | no data | S20, S24 |
| Toast | success, error, info | auto-dismiss | all |
| File upload | single, archive | dragging, uploading, invalid | S07, S18, S25, S26 |

## Inferred data model

```
Tenant        id, name, region, created_at
              evidence: instance-level settings S26, pricing per instance
              confidence: high

User          id, tenant_id, email, name, role (admin | developer | monitor | viewer)
              evidence: S27, role-gated menus in docs
              confidence: medium (Oracle uses IDCS / IAM groups; roles here are simplified)

Project       id, tenant_id, name, identifier, description, shared (bool), created_by, updated_at
              evidence: S02/S03, Gen3 projects docs (bundle of integrations, connections, lookups, libraries)
              confidence: high

Connection    id, project_id (nullable = global), name, identifier, adapter_type,
              role (trigger | invoke | trigger_and_invoke), properties (json: base URL, host, port, db name...),
              security_policy (basic | oauth_cc | oauth_code | api_key | none), secret_ref,
              agent_group_id (nullable), status (draft | configured | failed), last_tested_at, last_test_error
              evidence: S14-S16, connection docs (roles, policies, test before save), /v1/connections API
              confidence: high

AdapterType   code (rest | soap | ftp | db_postgres | db_mysql | db_oracle | scheduler ...), version,
              supported_roles, connection_schema (json schema for S16 form), operation_schema (for S07)
              evidence: adapter guides, S15
              confidence: high (shape), guess (field names)

Integration   id, project_id, name, identifier, version (major.minor.patch), style (application | scheduled),
              status (draft | configured | activating | active | failed | inactive),
              definition (json: the flow graph), business_identifiers (json: up to 3, one primary),
              tracing_level (production | audit | debug), locked_by, activated_at, updated_at
              unique (tenant, identifier, version)
              evidence: S04-S06, S11, S12, /v1/integrations/{code}/{version}
              confidence: high

Endpoint      id, integration_id, connection_id, kind (trigger | invoke), name,
              config (json: path, verb, operation, query/table, file pattern), request_schema, response_schema
              evidence: S07 wizard steps
              confidence: medium (stored separately or inside definition: architect's call)

Map           id, integration_id, node_id, sources (json), target_schema, mapping (json expression tree),
              compiled_xslt_or_js (text)
              evidence: S08, XSLT code view
              confidence: medium

Schedule      id, integration_id, kind (simple | ical), expression, timezone, start_at, end_at,
              status (active | paused), next_run_at
              evidence: S10, scheduled integration docs
              confidence: high

Lookup        id, project_id, name, domains (text[]), rows (json[][]), updated_at
              evidence: S17, /v1/lookups
              confidence: high

Library       id, project_id, name, version, file_ref, functions (json: name, params, return type)
              evidence: S18
              confidence: high

AgentGroup    id, tenant_id, name, identifier;  Agent  id, group_id, host, version, last_heartbeat_at
              evidence: S19, connectivity agent docs
              confidence: high

Instance      id, integration_id, integration_version, status (running | succeeded | failed | aborted),
              trigger_kind (request | schedule | resubmit), parent_instance_id (for resubmits),
              business_ids (json: primary + secondaries, indexed), started_at, ended_at, duration_ms,
              error_summary, recoverable (bool)
              evidence: S21-S23, resubmit docs ("new run tracked separately"), business identifier docs
              confidence: high

ActivityStep  id, instance_id, seq, node_id, node_type, status, started_at, ended_at,
              input_payload_ref, output_payload_ref, message
              evidence: S22 activity stream, payload per step
              confidence: high (shape), medium (granularity)

Payload       id, instance_id, step_id, content_type, size_bytes, storage_ref, expires_at
              evidence: payload viewer, tracing levels, retention
              confidence: medium

Certificate   id, tenant_id, alias, type (trust | identity), pem, expires_at
              evidence: S26
              confidence: medium

ApiKey / Credential  id, tenant_id, name, hash, scopes
              evidence: public REST API exists (/v1/...)
              confidence: guess
```

AiSession    id, tenant_id, user_id, project_id, integration_id (nullable), created_at
             evidence: clone-only (S28)
             confidence: design decision

AiMessage    id, session_id, role (user | assistant | tool), content, created_at
             evidence: clone-only
             confidence: design decision

AiChange     id, session_id, integration_id, base_version, proposed_definition (json),
             diff (json), status (proposed | accepted | partially_accepted | rejected),
             validation_errors, model, prompt_tokens, completion_tokens, decided_by, decided_at
             evidence: clone-only (S29); doubles as the audit log
             confidence: design decision

Relationships: Tenant 1-n Project; Project 1-n Integration, Connection, Lookup,
Library; Integration 1-n Endpoint (each n-1 Connection); Integration 1-n Map;
Integration 0-1 Schedule; Integration 1-n Instance; Instance 1-n ActivityStep;
ActivityStep 0-2 Payload; Instance 0-1 parent Instance (resubmit chain);
AgentGroup 1-n Agent, 1-n Connection.

## Runtime (not a screen, but the product)

What actually has to exist behind the canvas:

- **Flow engine**: executes the definition graph step by step: invoke, map,
  assign, switch, for-each, while, scope with fault handlers, wait, stop,
  throw/re-throw fault. Persists every step for S22.
- **Trigger runtime**: hosts an HTTP endpoint per active application
  integration (REST, SOAP), and a scheduler for scheduled ones.
- **Sync vs async**: sync calls return the response, capped (OIC: 300 s, then
  504). Async runs go through a durable queue.
- **Mapping runtime**: OIC compiles to XSLT and XPath. A clone can use JSONata
  or JS expressions instead (simpler, JSON-native). This is the biggest
  design decision for replica-architect.
- **Adapters**: one plugin interface (connection schema, test(), operations
  schema, invoke(), optional trigger()).
- **Limits** worth copying as defaults: 100 MB structured payload on cloud
  endpoints, 10 MB for DB/queues, 1 GB binary, 50 MB via agent.
- **Retry and resubmit**: failed async instances are recoverable from the last
  persisted input.
- **AI builder (clone-only)**: an LLM with tools, not free-text generation.
  The flow definition gets a strict JSON schema. The model works through tools
  like `list_connections`, `list_adapters`, `get_operation_schema`,
  `propose_flow`, `propose_map`, `dry_run` and `ask_user`. Every proposal is
  validated against the schema and the canvas rules before the user sees it.
  The model never sees secrets and never activates anything. This only works
  if the definition format is designed for both the canvas and the AI, so
  replica-architect must design it first.
- **Metering**: OIC bills in messages per hour (packs of 5,000). Count
  messages from day one, since pricing (replica-launch) will need it.

## Feature matrix

See `features.csv`. Must: 42, should: 22, could: 13, skip: 9 (8 must rows
are the clone-only AI builder).

## Out of scope (cannot or should not be cloned)

- **Oracle SaaS adapters** (ERP Cloud, HCM, EBS, NetSuite, Siebel, JD Edwards...):
  build them later only against each system's own public API, with your own
  credentials. Oracle's adapter code, WSDL bundles and business-event
  catalogues are theirs.
- **The 100+ adapter catalogue**: ship 6 to 8, add more on demand.
- **Process Automation, B2B/EDI trading partners, File Server, HL7/FHIR,
  Visual Builder, Insight**: not in this slice.
- **OCI infrastructure**: IAM/IDCS, OCI Vault, VCN private endpoints, regional
  DR. Use your own auth and secret store.
- **Oracle branding, names and icons**: "Oracle Integration", "OIC", the
  Redwood design system, Oracle's adapter icons. replica-brand replaces them.
- **XSLT/JDeveloper compatibility and import of real OIC .iar/.car archives**:
  that is reverse-engineering a proprietary format; skip it.
- **OIC's AI assistant and best-practice checker**: rebuild the idea with your
  own model calls later if wanted, not their prompts or rules.

## Size

Screens 29, flows 12, entities 21. Hard parts:

0. **English to a correct, runnable flow.** Tool-calling over a strict
   definition schema, clarifying questions, generated maps that really match
   the schemas, and a dry run to prove it. Reliability here is the whole pitch,
   so build an eval set of 50+ real integration requests early and measure
   against it.
1. **The flow engine.** Durable, step-persisted execution with scopes, fault
   handlers, loops, sync timeouts and resubmit. This is the product.
2. **The mapper.** Schema trees from JSON/XML/WSDL samples, drag-to-map, an
   expression language with functions, lookups and JS libraries, plus a
   test pane.
3. **The canvas.** Nested blocks (switch, scope, loops) with insert points,
   validation badges and a read-only replay mode for S22.

Also hard: an adapter SDK that makes new adapters cheap, secret handling and
OAuth flows, multi-tenant runtime isolation, and an on-prem agent (defer it).

Size: **L** (a quarter for a small team) for the must rows, with REST, SOAP,
SFTP, Postgres/MySQL and scheduler adapters. Full parity with OIC is XL: the
adapter catalogue alone is years of work. Ship the must rows, sell to a
niche, and add adapters as customers ask.

## Positioning hints (for replica-entrepreneur to verify)

Signals from the pricing and licensing sources (all third party, unverified):
hourly billing per instance even at zero usage (around $31/day minimum for
Enterprise), messages-per-hour packs, Standard vs Enterprise gating. Possible
angles to test against real reviews: flat or usage-only pricing, self-hostable,
JSON-first mapping instead of XSLT, Git-based versioning, cheaper for small
teams moving off OIC Gen 2 (end of life Aug 2025).
