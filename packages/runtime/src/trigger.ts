import { createInstance, type Db, type Integration } from "@oicr/db";
import { executeInstance } from "./execute.js";
import { tenantLimits } from "./limits.js";
import { enqueueRun } from "./queue.js";

export interface TriggerResult {
  instanceId: string;
  duplicate: boolean;
  /** Present for sync runs. */
  response?: { status: number; body: unknown };
  status: string;
  error?: { code: string; message: string };
}

/**
 * Starts a run of an integration. Sync http triggers run inline (the caller
 * waits); everything else is queued for the worker.
 */
export async function startRun(
  db: Db,
  integration: Integration,
  args: { input: unknown; kind: "request" | "manual" | "schedule"; idempotencyKey?: string | null; sync?: boolean },
): Promise<TriggerResult> {
  const { instance, duplicate } = await createInstance(db, {
    orgId: integration.orgId,
    integration,
    triggerKind: args.kind,
    input: args.input,
    idempotencyKey: args.idempotencyKey,
  });
  if (duplicate) return { instanceId: instance.id, duplicate, status: instance.status };

  if (args.sync) {
    const timeout = AbortSignal.timeout(Number(process.env.SYNC_TIMEOUT_SECONDS ?? 120) * 1000);
    const { instance: done, result } = await executeInstance(db, instance.id, { signal: timeout });
    return {
      instanceId: done.id,
      duplicate,
      status: done.status,
      response: result?.response,
      error: done.errorCode ? { code: done.errorCode, message: done.errorMessage ?? "" } : undefined,
    };
  }
  const limits = await tenantLimits(db, integration.orgId);
  await enqueueRun(instance.id, { tenant: integration.orgId, tier: limits.tier }, instance.lane);
  return { instanceId: instance.id, duplicate, status: "queued" };
}
