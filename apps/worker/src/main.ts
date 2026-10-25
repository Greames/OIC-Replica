import {
  claimDueSchedules,
  createDb,
  EVENTS_CHANNEL,
  emitEvent,
  failStaleInstances,
  recoverStuckAiSessions,
} from "@oicr/db";
import { deliverDue } from "@oicr/notify";
import { executeInstance, getQueue, RUN_QUEUE, type RunJob, startRun, stopQueue } from "@oicr/runtime";

// The worker: runs queued instances, fires schedules, and reaps runs whose
// worker died. Several workers can run side by side; Postgres locks keep each
// schedule and instance with exactly one of them.

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));

const db = createDb();
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
const tickMs = Number(process.env.SCHEDULER_TICK_MS ?? 15_000);
const staleAfterMs = Number(process.env.STALE_RUN_MINUTES ?? 30) * 60_000;
const controller = new AbortController();
const appUrl = process.env.APP_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000";

// Notifications: drain due deliveries now, then again on every new event and every 2 s.
let delivering = false;
let again = false;
async function deliver(): Promise<void> {
  if (delivering) {
    again = true;
    return;
  }
  delivering = true;
  try {
    do {
      again = false;
      for (let i = 0; i < 10; i++) {
        const r = await deliverDue(db, { appUrl });
        if (r.sent + r.retry + r.failed > 0) log("notifications", r);
        else break;
      }
    } while (again);
  } catch (e) {
    log("notification error", { error: (e as Error).message });
  } finally {
    delivering = false;
  }
}

async function schedulerTick(): Promise<void> {
  try {
    for (const due of await claimDueSchedules(db)) {
      if (due.skipped) {
        log("schedule skipped: previous run still active", { integration: due.integration.identifier });
        await emitEvent(db, {
          orgId: due.integration.orgId,
          type: "schedule.skipped",
          severity: "warning",
          subjectType: "integration",
          subjectId: due.integration.id,
          summary: `"${due.integration.name}" skipped a scheduled run because the previous run is still going.`,
          path: `/integrations/${due.integration.id}`,
        });
        continue;
      }
      const r = await startRun(db, due.integration, {
        input: { scheduledFor: due.scheduledFor.toISOString() },
        kind: "schedule",
      });
      log("schedule fired", { integration: due.integration.identifier, instance: r.instanceId });
    }
  } catch (e) {
    log("scheduler error", { error: (e as Error).message });
  }
}

async function reap(): Promise<void> {
  try {
    const n = await failStaleInstances(db, staleAfterMs);
    if (n > 0) log("marked stale runs failed", { count: n });
    // An AI turn lasts minutes at most; one still "running" after 15 lost its server.
    const ai = await recoverStuckAiSessions(db, 15 * 60_000);
    if (ai > 0) log("released interrupted AI conversations", { count: ai });
  } catch (e) {
    log("reaper error", { error: (e as Error).message });
  }
}

async function main(): Promise<void> {
  const boss = await getQueue({ worker: true });
  await boss.work<RunJob>(RUN_QUEUE, { localConcurrency: concurrency, batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { instance } = await executeInstance(db, job.data.instanceId, { signal: controller.signal });
    log("run finished", { instance: instance.id, status: instance.status, ms: instance.durationMs });
  });

  await db.$client.listen(EVENTS_CHANNEL, () => void deliver());
  const timers = [setInterval(schedulerTick, tickMs), setInterval(reap, 60_000), setInterval(deliver, 2_000)];
  void schedulerTick();
  void reap();
  void deliver();
  log("worker started", { concurrency, tickMs });

  const shutdown = async (signal: string) => {
    log("worker stopping", { signal });
    for (const t of timers) clearInterval(t);
    await stopQueue();
    controller.abort();
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
