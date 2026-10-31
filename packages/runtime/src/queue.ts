import { injectContext } from "@oicr/platform";
import { PgBoss } from "pg-boss";

export const RUN_QUEUE = "run-instance";
/** Runs with a pipeline step: taken by the batch engine (apps/batch). */
export const BATCH_QUEUE = "run-batch";

export interface RunJob {
  instanceId: string;
  tenant?: string;
  /** W3C trace context of whoever queued it, so the worker continues the same trace. */
  trace?: Record<string, string>;
}

let shared: Promise<PgBoss> | undefined;

/**
 * The job queue (pg-boss, in the same Postgres). The web app only sends;
 * the worker also supervises and consumes. pg-boss manages its own schema, so
 * it connects with QUEUE_DATABASE_URL (a role allowed to create it) when the
 * application role is restricted; its jobs carry run ids only, no tenant data.
 */
export function getQueue(opts: { url?: string; worker?: boolean } = {}): Promise<PgBoss> {
  shared ??= (async () => {
    const url = opts.url ?? process.env.QUEUE_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const boss = new PgBoss({
      connectionString: url,
      max: 4,
      supervise: opts.worker ?? false,
      schedule: false,
      migrate: true,
    });
    boss.on("error", (e) => console.error("[queue]", e));
    await boss.start();
    await boss.createQueue(RUN_QUEUE, { policy: "standard" });
    await boss.createQueue(BATCH_QUEUE, { policy: "standard" });
    return boss;
  })();
  return shared;
}

/**
 * Queues a run. The tenant is the job's group, so workers cap each tenant's
 * concurrent runs (by tier) and one busy tenant cannot starve the others.
 * Batch runs go to the batch engine; they may run for hours, and a stopped
 * one is resumed from its checkpoints rather than retried by the queue.
 */
export async function enqueueRun(
  instanceId: string,
  group?: { tenant: string; tier: string },
  lane: "standard" | "batch" = "standard",
): Promise<void> {
  const boss = await getQueue();
  await boss.send(
    lane === "batch" ? BATCH_QUEUE : RUN_QUEUE,
    { instanceId, tenant: group?.tenant, trace: injectContext() } satisfies RunJob,
    {
      retryLimit: 0,
      singletonKey: instanceId,
      ...(lane === "batch" ? { expireInSeconds: 24 * 3600 } : {}),
      ...(group ? { group: { id: group.tenant, tier: group.tier } } : {}),
    },
  );
}

export async function stopQueue(): Promise<void> {
  if (!shared) return;
  const boss = await shared;
  shared = undefined;
  await boss.stop({ graceful: true, close: true });
}
