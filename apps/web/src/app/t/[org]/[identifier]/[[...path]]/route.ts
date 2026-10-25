import { timingSafeEqual } from "node:crypto";
import { findActiveTrigger } from "@oicr/db";
import { FlowDoc } from "@oicr/flow-schema";
import { startRun } from "@oicr/runtime";
import { db } from "@/lib/db";

// Trigger endpoint for active application integrations:
//   {METHOD} /t/{org slug}/{integration identifier}{trigger path}
//   Authorization: Bearer <trigger token>     (shown on the integration page)
//   Idempotency-Key: <optional, dedupes repeats>
// The request body (or the query, for GET) becomes $trigger.
// Sync integrations answer with their `return` step; others get 202 + run id.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BODY_BYTES = 10 * 1024 * 1024;

type Params = { params: Promise<{ org: string; identifier: string; path?: string[] }> };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers });
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req: Request, { params }: Params): Promise<Response> {
  const { org, identifier, path = [] } = await params;
  const found = await findActiveTrigger(db, org, identifier);
  if (!found) return json(404, { error: "not_found", message: "No active integration at this address." });

  const doc = FlowDoc.safeParse(found.integration.definition);
  if (!doc.success || doc.data.trigger.type !== "http") {
    return json(404, { error: "not_found", message: "This integration is not started by HTTP calls." });
  }
  const trigger = doc.data.trigger;

  const given = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!found.token || !sameToken(given, found.token)) {
    return json(
      401,
      { error: "unauthorized", message: "Send the integration's token as Authorization: Bearer <token>." },
      { "www-authenticate": "Bearer" },
    );
  }

  const wantPath = trigger.path.replace(/\/+$/, "") || "/";
  const gotPath = `/${path.join("/")}`.replace(/\/+$/, "") || "/";
  if (wantPath !== gotPath)
    return json(404, { error: "not_found", message: `This integration listens on ${wantPath}.` });
  if (req.method !== trigger.method) {
    return json(405, { error: "method_not_allowed", message: `Use ${trigger.method}.` }, { allow: trigger.method });
  }

  let input: unknown;
  if (req.method === "GET" || req.method === "DELETE") {
    input = Object.fromEntries(new URL(req.url).searchParams);
  } else {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return json(413, { error: "too_large", message: "The body is over 10 MB." });
    }
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES)
      return json(413, { error: "too_large", message: "The body is over 10 MB." });
    if (/json/i.test(req.headers.get("content-type") ?? "") || /^\s*[[{]/.test(text)) {
      try {
        input = text ? JSON.parse(text) : {};
      } catch {
        return json(400, { error: "invalid_json", message: "The body is not valid JSON." });
      }
    } else {
      input = text;
    }
  }

  const run = await startRun(db, found.integration, {
    input,
    kind: "request",
    sync: trigger.sync,
    idempotencyKey: req.headers.get("idempotency-key"),
  });
  const headers = { "x-run-id": run.instanceId };

  if (run.duplicate) return json(200, { duplicate: true, runId: run.instanceId, status: run.status }, headers);
  if (!trigger.sync) return json(202, { runId: run.instanceId, status: "queued" }, headers);
  if (run.status !== "succeeded") {
    return json(
      run.error?.code === "aborted" ? 504 : 500,
      { error: run.error?.code ?? "failed", message: run.error?.message, runId: run.instanceId },
      headers,
    );
  }
  if (run.response) return json(run.response.status, run.response.body ?? null, headers);
  return json(200, { runId: run.instanceId, status: run.status }, headers);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
