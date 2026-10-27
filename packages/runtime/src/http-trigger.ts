import { type Db, findActiveTrigger, type Integration, verifyTriggerToken } from "@oicr/db";
import { FlowDoc } from "@oicr/flow-schema";
import { startRun } from "./trigger.js";

// The trigger endpoint, independent of any HTTP framework. The stream engine
// (apps/stream) serves it; the web app only forwards to it.
//
//   {METHOD} /t/{org slug}/{integration identifier}{trigger path}
//   Authorization: Bearer <trigger token>
//   Idempotency-Key: <optional, dedupes repeats>
// The body (or the query, for GET and DELETE) becomes $trigger. Sync
// integrations answer with their `return` step; others get 202 and a run id.

export const MAX_TRIGGER_BODY_BYTES = 10 * 1024 * 1024;

/** A resolved, active HTTP trigger: what to run and how it is called. */
export interface TriggerRoute {
  integration: Integration;
  tokenHash: string | null;
  method: string;
  path: string;
  sync: boolean;
}

export interface TriggerCall {
  method: string;
  /** The path after /t/{org}/{identifier}, as segments. */
  path: string[];
  header(name: string): string | undefined;
  query: URLSearchParams;
  /** The raw body, already size-checked by the server. */
  body: string;
}

export interface TriggerReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Loads the route for /t/{org}/{identifier}: null when there is no active
 * integration there, or it is not started by HTTP. Uses the active plan, so
 * the route matches exactly what runs.
 */
export async function resolveTriggerRoute(db: Db, org: string, identifier: string): Promise<TriggerRoute | null> {
  const found = await findActiveTrigger(db, org, identifier);
  if (!found) return null;
  const doc = FlowDoc.safeParse(found.plan?.definition ?? found.integration.definition);
  if (!doc.success || doc.data.trigger.type !== "http") return null;
  const t = doc.data.trigger;
  return {
    integration: found.integration,
    tokenHash: found.tokenHash,
    method: t.method,
    path: t.path.replace(/\/+$/, "") || "/",
    sync: t.sync,
  };
}

const reply = (status: number, body: unknown, headers?: Record<string, string>): TriggerReply => ({
  status,
  body,
  headers,
});

/** Checks a call against its route, then runs it. */
export async function handleTriggerCall(db: Db, route: TriggerRoute, call: TriggerCall): Promise<TriggerReply> {
  const given = call.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!verifyTriggerToken(given, route.tokenHash)) {
    return reply(
      401,
      { error: "unauthorized", message: "Send the integration's token as Authorization: Bearer <token>." },
      { "www-authenticate": "Bearer" },
    );
  }
  const gotPath = `/${call.path.join("/")}`.replace(/\/+$/, "") || "/";
  if (route.path !== gotPath)
    return reply(404, { error: "not_found", message: `This integration listens on ${route.path}.` });
  if (call.method !== route.method)
    return reply(405, { error: "method_not_allowed", message: `Use ${route.method}.` }, { allow: route.method });

  let input: unknown;
  if (call.method === "GET" || call.method === "DELETE") input = Object.fromEntries(call.query);
  else if (/json/i.test(call.header("content-type") ?? "") || /^\s*[[{]/.test(call.body)) {
    try {
      input = call.body ? JSON.parse(call.body) : {};
    } catch {
      return reply(400, { error: "invalid_json", message: "The body is not valid JSON." });
    }
  } else input = call.body;

  const idempotencyKey = call.header("idempotency-key")?.slice(0, 200) ?? null;
  const run = await startRun(db, route.integration, { input, kind: "request", idempotencyKey, sync: route.sync });
  const headers = { "x-run-id": run.instanceId };
  if (run.duplicate) return reply(200, { duplicate: true, runId: run.instanceId, status: run.status }, headers);
  if (!route.sync) return reply(202, { runId: run.instanceId, status: "queued" }, headers);
  if (run.status !== "succeeded")
    return reply(
      run.error?.code === "aborted" ? 504 : 500,
      { error: run.error?.code ?? "failed", message: run.error?.message, runId: run.instanceId },
      headers,
    );
  if (run.response) return reply(run.response.status, run.response.body ?? null, headers);
  return reply(200, { runId: run.instanceId, status: run.status }, headers);
}
