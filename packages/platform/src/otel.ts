import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

// Installs the OpenTelemetry SDK for a service (web, worker, stream engine).
// Off unless configured with the standard variables:
//   OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  → OTLP over HTTP
//   OTEL_TRACES_EXPORTER=console                                      → stdout (debugging)
//   OTEL_TRACES_SAMPLER_ARG=0.1                                       → keep 10% of new traces
//   OTEL_EXPORTER_OTLP_HEADERS, OTEL_RESOURCE_ATTRIBUTES              → as usual

export interface Telemetry {
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

let installed: Telemetry | null = null;

function installGlobals(provider: TracerProvider): void {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  );
  trace.setGlobalTracerProvider(provider);
}

function resourceAttributes(serviceName: string, serviceVersion?: string): Record<string, string> {
  const extra = Object.fromEntries(
    (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "")
      .split(",")
      .map((pair) => pair.split("=").map((s) => s.trim()))
      .filter((kv): kv is [string, string] => kv.length === 2 && Boolean(kv[0]) && Boolean(kv[1])),
  );
  return {
    "service.name": process.env.OTEL_SERVICE_NAME || serviceName,
    ...(serviceVersion ? { "service.version": serviceVersion } : {}),
    "deployment.environment.name": process.env.NODE_ENV ?? "development",
    ...extra,
  };
}

/** Starts tracing when configured; returns null (and changes nothing) otherwise. Safe to call twice. */
export function startTelemetry(opts: { serviceName: string; serviceVersion?: string }): Telemetry | null {
  if (installed) return installed;
  const otlp = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const consoleOut = process.env.OTEL_TRACES_EXPORTER === "console";
  if (process.env.OTEL_SDK_DISABLED === "true" || (!otlp && !consoleOut)) return null;
  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? 1);
  const processors: SpanProcessor[] = [];
  if (otlp) processors.push(new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }));
  if (consoleOut) processors.push(new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() }));
  const provider = new TracerProvider({
    resource: resourceFromAttributes(resourceAttributes(opts.serviceName, opts.serviceVersion)),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1),
    }),
    spanProcessors: processors,
  });
  installGlobals(provider);
  installed = { shutdown: () => provider.shutdown(), forceFlush: () => provider.forceFlush() };
  return installed;
}

/** For tests: records every span in memory. */
export function startTestTelemetry(): { exporter: InMemorySpanExporter; telemetry: Telemetry } {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  installGlobals(provider);
  installed = { shutdown: () => provider.shutdown(), forceFlush: () => provider.forceFlush() };
  return { exporter, telemetry: installed };
}
