import "server-only";
import { type AiEvent, runTurn } from "@oicr/ai";
import {
  type Actor,
  acceptAiChange,
  activateIntegration,
  ConflictError,
  createAiSession,
  deactivateIntegration,
  type Event,
  ForbiddenError,
  getAiSession,
  getInstance,
  getIntegration,
  getSemanticGraph,
  INSTANCE_STATUSES,
  InvalidStateError,
  listEvents,
  listInstances,
  listIntegrations,
  listLookups,
  listProjects,
  loadLookup,
  NotFoundError,
  rejectAiChange,
} from "@oicr/db";
import { startRun } from "@oicr/runtime";
import { z } from "zod";
import { aiHint, getModel } from "./ai";
import { db } from "./db";

// What scripts and agents can do: the public API (/api/v1) and the MCP server
// (/mcp) both call these, so they behave the same. Every function takes the
// caller's Actor; API keys are narrowed to their scopes there.

/** An error a caller can act on, with an HTTP status. */
export class OpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function toOpError(e: unknown): OpError {
  if (e instanceof OpError) return e;
  if (e instanceof NotFoundError) return new OpError(404, "not_found", e.message);
  if (e instanceof ForbiddenError) return new OpError(403, "forbidden", `${e.message} Give the API key that scope.`);
  if (e instanceof ConflictError) return new OpError(409, "conflict", e.message);
  if (e instanceof InvalidStateError) return new OpError(409, "invalid_state", e.message);
  if (e instanceof z.ZodError)
    return new OpError(400, "invalid", e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  throw e;
}

export const appBase = () =>
  (process.env.APP_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(/\/$/, "");
const link = (path: string | null | undefined) => (path ? `${appBase()}${path}` : null);

export function eventView(e: Event) {
  return {
    id: e.id,
    type: e.type,
    severity: e.severity,
    summary: e.summary,
    url: link(e.path),
    subject_type: e.subjectType,
    subject_id: e.subjectId,
    data: e.data,
    created_at: e.createdAt.toISOString(),
  };
}

export const EventsQuery = z.object({
  since_id: z.coerce.number().int().min(0).optional(),
  types: z.array(z.string()).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function opListEvents(actor: Actor, q: z.input<typeof EventsQuery>) {
  const p = EventsQuery.parse(q);
  const r = await listEvents(db, actor, { sinceId: p.since_id ?? 0, types: p.types, limit: p.limit ?? 100 });
  return { events: r.events.map(eventView), next_since_id: r.nextSinceId };
}

export async function opListProjects(actor: Actor) {
  return (await listProjects(db, actor)).map((p) => ({ id: p.id, name: p.name, identifier: p.identifier }));
}

export async function opListLookups(actor: Actor, opts: { rows?: boolean } = {}) {
  const rows = await listLookups(db, actor);
  return Promise.all(
    rows.map(async (l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      domains: l.domains,
      row_count: l.rowCount,
      ...(opts.rows ? { rows: (await loadLookup(db, actor.orgId, l.name))?.rows ?? [] } : {}),
      url: link(`/lookups/${l.id}`),
    })),
  );
}

/** The semantic catalog: entities, and the system objects bound to them field by field. */
export async function opSemanticCatalog(actor: Actor, q: { system?: string; entity?: string } = {}) {
  const graph = await getSemanticGraph(db, actor);
  return {
    entities: graph
      .entities()
      .filter((e) => !q.entity || e.name === q.entity)
      .map((e) => ({
        name: e.name,
        description: e.description,
        origin: e.origin,
        attributes: e.attributes.map((a) => ({
          name: a.name,
          type: a.type,
          description: a.description,
          ...(a.identifier ? { identifier: true } : {}),
          ...(a.references ? { references: a.references } : {}),
        })),
      })),
    objects: graph
      .objects({ system: q.system || undefined, entity: q.entity || undefined })
      .filter((o) => o.fields.length > 0)
      .map((o) => ({
        system: o.system,
        object: o.object,
        entity: o.entity,
        origin: o.origin,
        fields: o.fields.map((f) => ({
          field: f.field,
          attribute: f.attribute,
          ...(f.read ? { read: f.read } : {}),
          ...(f.write ? { write: f.write } : {}),
          ...(f.readOnly ? { read_only: true } : {}),
          origin: f.origin,
        })),
        url: link(`/catalog/systems/${encodeURIComponent(o.system)}/${encodeURIComponent(o.object)}`),
      })),
  };
}

export async function opListIntegrations(actor: Actor, q: { project_id?: string } = {}) {
  const rows = await listIntegrations(db, actor, { projectId: q.project_id });
  return rows.map((i) => ({
    id: i.id,
    name: i.name,
    identifier: i.identifier,
    version: i.version,
    style: i.style,
    status: i.status,
    project: i.projectName,
    updated_at: i.updatedAt.toISOString(),
    url: link(`/integrations/${i.id}`),
  }));
}

export async function opGetIntegration(actor: Actor, id: string) {
  const i = await getIntegration(db, actor, id);
  return {
    id: i.id,
    name: i.name,
    identifier: i.identifier,
    version: i.version,
    style: i.style,
    status: i.status,
    project: i.projectName,
    schedule: i.schedule
      ? {
          kind: i.schedule.kind,
          expression: i.schedule.expression,
          timezone: i.schedule.timezone,
          next_run_at: i.schedule.nextRunAt?.toISOString() ?? null,
        }
      : null,
    definition: i.definition,
    url: link(`/integrations/${i.id}`),
  };
}

export const RunsQuery = z.object({
  integration_id: z.string().uuid().optional(),
  status: z.enum(INSTANCE_STATUSES).optional(),
  business_id: z.string().optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function opListRuns(actor: Actor, q: z.input<typeof RunsQuery>) {
  const p = RunsQuery.parse(q);
  const r = await listInstances(db, actor, {
    integrationId: p.integration_id,
    status: p.status,
    businessId: p.business_id,
    before: p.before,
    limit: p.limit ?? 20,
  });
  return {
    runs: r.items.map((x) => ({
      id: x.id,
      status: x.status,
      integration: { id: x.integrationId, name: x.integrationName, version: x.integrationVersion },
      trigger: x.triggerKind,
      business_id: x.primaryBusinessId,
      error: x.errorCode ? { code: x.errorCode, message: x.errorMessage } : null,
      duration_ms: x.durationMs,
      created_at: x.createdAt.toISOString(),
      url: link(`/observability/runs/${x.id}`),
    })),
    next: r.next,
  };
}

/** Long payloads are cut so an agent's context is not flooded. */
function clip(v: unknown, max = 2000): unknown {
  if (v === undefined || v === null) return v ?? null;
  const s = JSON.stringify(v);
  return s.length <= max ? v : `${s.slice(0, max)}… (${s.length - max} more characters)`;
}

export async function opGetRun(actor: Actor, id: string) {
  const r = await getInstance(db, actor, id);
  const failed = r.steps.find((s) => s.status === "failed");
  return {
    id: r.id,
    status: r.status,
    integration: {
      id: r.integrationId,
      name: r.integrationName,
      identifier: r.integrationIdentifier,
      version: r.integrationVersion,
    },
    trigger: r.triggerKind,
    business_ids: r.businessIds,
    error: r.errorCode ? { code: r.errorCode, message: r.errorMessage, step: failed?.stepId ?? null } : null,
    input: clip(r.input),
    output: clip(r.output),
    duration_ms: r.durationMs,
    created_at: r.createdAt.toISOString(),
    steps: r.steps.map((s) => ({
      step: s.stepId,
      type: s.stepType,
      status: s.status,
      iteration: s.iteration,
      message: s.message,
      input: clip(s.input, 600),
      output: clip(s.output, 600),
    })),
    url: link(`/observability/runs/${r.id}`),
  };
}

export async function opActivate(actor: Actor, id: string) {
  const i = await activateIntegration(db, actor, id);
  return { id: i.id, status: i.status, version: i.version };
}

export async function opDeactivate(actor: Actor, id: string) {
  const i = await deactivateIntegration(db, actor, id);
  return { id: i.id, status: i.status, version: i.version };
}

/** Starts a run with a payload. Sync http integrations answer inline; others are queued. */
export async function opRun(actor: Actor, id: string, input: unknown) {
  // Running is an operate action; check before reading anything else.
  if (actor.scopes && !actor.scopes.includes("operate")) throw new ForbiddenError("operate");
  const integration = await getIntegration(db, actor, id);
  if (integration.status !== "active")
    throw new OpError(409, "inactive", "Activate the integration before running it.");
  const def = integration.definition as { trigger?: { type?: string; sync?: boolean } };
  const sync = def.trigger?.type === "http" && def.trigger.sync === true;
  const r = await startRun(db, integration, { input: input ?? {}, kind: "manual", sync });
  return {
    run_id: r.instanceId,
    status: r.status,
    response: r.response ?? null,
    error: r.error ?? null,
    url: link(`/observability/runs/${r.instanceId}`),
  };
}

/** One turn of the AI builder, collected instead of streamed. */
async function turn(actor: Actor, sessionId: string, text: string) {
  const model = getModel();
  if (!model) throw new OpError(503, "ai_disabled", `The AI builder is off. ${aiHint()}`);
  let reply = "";
  let question: { question: string; choices: string[] } | null = null;
  const proposals: { change_id: string; summary: string }[] = [];
  const errors: string[] = [];
  const emit = (e: AiEvent) => {
    if (e.type === "text") reply += e.delta;
    else if (e.type === "question") question = { question: e.question, choices: e.choices };
    else if (e.type === "proposal") proposals.push({ change_id: e.changeId, summary: e.summary });
    else if (e.type === "error") errors.push(e.message);
  };
  const status = await runTurn({ db, actor, sessionId, text, model, emit });
  return {
    session_id: sessionId,
    status: status === "waiting" ? "waiting_for_answer" : status,
    reply: reply.trim(),
    question,
    proposals,
    error: errors[0] ?? null,
    url: link(`/ai/${sessionId}`),
    next: question
      ? "Answer with continue_ai_build."
      : proposals.length
        ? "Review the proposal, then accept_ai_change (or open the url to see the diff)."
        : "Reply with continue_ai_build if more is needed.",
  };
}

export async function opStartBuild(
  actor: Actor,
  args: { instruction: string; project_id?: string; integration_id?: string },
) {
  let projectId = args.project_id;
  if (!projectId && !args.integration_id) {
    const projects = await listProjects(db, actor);
    if (projects.length !== 1)
      throw new OpError(
        400,
        "project_required",
        `Say which project: ${projects.map((p) => `${p.name} (${p.id})`).join(", ") || "there are none yet"}.`,
      );
    projectId = projects[0]!.id;
  }
  const session = await createAiSession(db, actor, {
    projectId,
    integrationId: args.integration_id,
    title: args.instruction,
  });
  return turn(actor, session.id, args.instruction);
}

export async function opContinueBuild(actor: Actor, args: { session_id: string; text: string }) {
  await getAiSession(db, actor, args.session_id);
  return turn(actor, args.session_id, args.text);
}

export async function opDecideChange(actor: Actor, args: { change_id: string; accept: boolean }) {
  if (!args.accept) {
    await rejectAiChange(db, actor, args.change_id);
    return { change_id: args.change_id, status: "rejected" };
  }
  const r = await acceptAiChange(db, actor, args.change_id);
  return {
    change_id: args.change_id,
    status: "accepted",
    integration_id: r.integrationId,
    url: link(`/integrations/${r.integrationId}`),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from a URL or a tool call: anything that is not a uuid cannot exist. */
export function uuidParam(id: string): string {
  if (!UUID_RE.test(id)) throw new OpError(404, "not_found", "Not found.");
  return id;
}
