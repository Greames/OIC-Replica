// Next.js calls this once per server process. Traces go to
// OTEL_EXPORTER_OTLP_ENDPOINT when set; otherwise tracing stays off.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTelemetry } = await import("@oicr/platform/otel");
  startTelemetry({ serviceName: "oicr-web" });
}
