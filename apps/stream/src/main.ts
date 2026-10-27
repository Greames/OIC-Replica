import { assertTenantIsolation, createDb, ROUTES_CHANNEL } from "@oicr/db";
import { currentTraceId } from "@oicr/platform";
import { startTelemetry } from "@oicr/platform/otel";
import { stopQueue } from "@oicr/runtime";
import { createStreamServer } from "./server.js";

// The stream engine process. Configuration:
//   STREAM_PORT (3001), STREAM_MAX_IN_FLIGHT (1000), STREAM_DRAIN_SECONDS (25)
//   DATABASE_URL (application role), QUEUE_DATABASE_URL, secret store and OTEL_* as elsewhere.

const telemetry = startTelemetry({ serviceName: "oicr-stream" });
const log = (msg: string, extra: Record<string, unknown> = {}) => {
  const trace = extra.trace ?? currentTraceId();
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra, ...(trace ? { trace } : {}) }));
};

const db = createDb();
const port = Number(process.env.STREAM_PORT ?? 3001);

async function main(): Promise<void> {
  await assertTenantIsolation(db, (m) => log(m));
  const stream = createStreamServer({ db, maxInFlight: Number(process.env.STREAM_MAX_IN_FLIGHT ?? 1000), log });
  // Activation, deactivation and new tokens are pushed here, so routes never go stale.
  await db.$client.listen(ROUTES_CHANNEL, (payload) => {
    try {
      stream.routes.invalidate((JSON.parse(payload) as { integrationId?: string }).integrationId);
    } catch {
      stream.routes.invalidate();
    }
  });
  stream.server.listen(port, () => log("stream engine listening", { port, tracing: telemetry ? "on" : "off" }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stream engine draining", { signal, inFlight: stream.inFlight() });
    await stream.drain(Number(process.env.STREAM_DRAIN_SECONDS ?? 25) * 1000);
    await stopQueue();
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
