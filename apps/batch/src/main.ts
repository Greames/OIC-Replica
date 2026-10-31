import { closeAdapters } from "@oicr/adapters";
import { assertTenantIsolation, createDb, requeueStaleBatchRuns } from "@oicr/db";
import { currentTraceId, extractContext } from "@oicr/platform";
import { startTelemetry } from "@oicr/platform/otel";
import {
  BATCH_QUEUE,
  enqueueRun,
  executeInstance,
  getQueue,
  type RunJob,
  runGroupConcurrency,
  stopQueue,
  tenantLimits,
} from "@oicr/runtime";

// The batch engine: runs integrations that contain pipeline steps. Each run
// reads, transforms (on worker threads) and writes in chunks with checkpoints,
// so memory stays bounded however large the source is. Runs whose engine
// stopped (no heartbeat) are put back on the queue and resume from their last
// checkpoint, here or in another instance.
//
// Settings: BATCH_CONCURRENCY (runs at once, 2), BATCH_THREADS (transform
// threads per pipeline), BATCH_STALE_SECONDS (120), BATCH_MAX_ATTEMPTS (3),
// BATCH_DRAIN_SECONDS (30).

const telemetry = startTelemetry({ serviceName: "oicr-batch" });

const log = (msg: string, extra: Record<string, unknown> = {}) => {
  const trace = currentTraceId();
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra, ...(trace ? { trace } : {}) }));
};

const db = createDb();
const concurrency = Number(process.env.BATCH_CONCURRENCY ?? 2);
const staleMs = Number(process.env.BATCH_STALE_SECONDS ?? 120) * 1000;
const maxAttempts = Number(process.env.BATCH_MAX_ATTEMPTS ?? 3);
const drainMs = Number(process.env.BATCH_DRAIN_SECONDS ?? 30) * 1000;
let running = 0;

/** Puts runs whose engine went quiet back on the queue, to resume from their checkpoints. */
async function resumeStale(): Promise<void> {
  try {
    const { requeued, failed } = await requeueStaleBatchRuns(db, staleMs, maxAttempts);
    for (const run of requeued) {
      const limits = await tenantLimits(db, run.orgId);
      await enqueueRun(run.id, { tenant: run.orgId, tier: limits.tier }, "batch");
    }
    if (requeued.length) log("resuming stopped batch runs", { count: requeued.length });
    if (failed) log("batch runs failed after too many attempts", { count: failed });
  } catch (e) {
    log("resume error", { error: (e as Error).message });
  }
}

async function main(): Promise<void> {
  await assertTenantIsolation(db, (msg) => log(msg));
  const boss = await getQueue({ worker: true });
  await boss.work<RunJob>(
    BATCH_QUEUE,
    { localConcurrency: concurrency, batchSize: 1, groupConcurrency: runGroupConcurrency() },
    async ([job]) => {
      if (!job) return;
      running++;
      try {
        const { instance } = await executeInstance(db, job.data.instanceId, {
          batch: true,
          parent: extractContext(job.data.trace),
        });
        log("batch run finished", { instance: instance.id, status: instance.status, ms: instance.durationMs });
      } finally {
        running--;
      }
    },
  );
  const timer = setInterval(resumeStale, Math.max(10_000, staleMs / 4));
  void resumeStale();
  log("batch engine started", { concurrency, staleSeconds: staleMs / 1000, tracing: telemetry ? "on" : "off" });

  const shutdown = async (signal: string) => {
    log("batch engine stopping", { signal, running });
    clearInterval(timer);
    // Stop taking runs, give running ones a moment, then leave: whatever is
    // still running is resumed from its last checkpoint by another instance.
    const stopping = stopQueue();
    const deadline = Date.now() + drainMs;
    while (running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    if (running > 0) log("leaving runs to resume elsewhere", { running });
    await Promise.race([stopping, new Promise((r) => setTimeout(r, 2000))]);
    await closeAdapters().catch(() => {});
    await telemetry?.shutdown().catch(() => {});
    await db.$client.end({ timeout: 5 });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
