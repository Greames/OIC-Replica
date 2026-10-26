import {
  type Attributes,
  type AttributeValue,
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

// Tracing helpers for every execution block. They use only the OpenTelemetry
// API, which does nothing until a service installs an SDK (see ./otel), so
// libraries can trace unconditionally at no cost.

export { type Context, type Span, SpanKind };

/** The current trace context. */
export const activeContext = (): Context => context.active();

/** Attribute names used across the platform. */
export const ATTR = {
  tenant: "oicr.tenant_id",
  integration: "oicr.integration_id",
  integrationVersion: "oicr.integration_version",
  run: "oicr.run_id",
  trigger: "oicr.trigger",
  step: "oicr.step_id",
  stepType: "oicr.step_type",
  iteration: "oicr.iteration",
  connection: "oicr.connection",
  attempt: "oicr.attempt",
  channel: "oicr.channel_kind",
  eventType: "oicr.event_type",
  aiProvider: "gen_ai.provider.name",
  aiModel: "gen_ai.request.model",
  aiInputTokens: "gen_ai.usage.input_tokens",
  aiOutputTokens: "gen_ai.usage.output_tokens",
  secretBackend: "oicr.secret_backend",
  secretKind: "oicr.secret_kind",
} as const;

const TRACER = "oicr";

export const tracer = () => trace.getTracer(TRACER);

/** Drops undefined values so callers can pass optional attributes directly. */
export function attrs(values: Record<string, AttributeValue | undefined | null>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export interface SpanOptions {
  kind?: SpanKind;
  /** Parent context; defaults to the active one. */
  parent?: Context;
}

/**
 * Runs `fn` inside a span. Thrown errors are recorded on the span (status
 * ERROR, exception event) and rethrown; the span always ends.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, AttributeValue | undefined | null>,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  const parent = options.parent ?? context.active();
  return tracer().startActiveSpan(
    name,
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: attrs(attributes) },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Marks a span as failed: for failures that are returned rather than thrown. */
export function recordError(span: Span, error: unknown, message?: string): void {
  if (error instanceof Error) span.recordException(error);
  else if (error !== undefined) span.recordException({ name: "Error", message: String(error) });
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: message ?? (error instanceof Error ? error.message : String(error ?? "error")),
  });
}

/** The active trace context as W3C headers (traceparent, tracestate, baggage), e.g. for a queued job. */
export function injectContext(
  carrier: Record<string, string> = {},
  ctx: Context = context.active(),
): Record<string, string> {
  propagation.inject(ctx, carrier);
  return carrier;
}

/** A context continued from W3C headers (an HTTP request, a queued job). */
export function extractContext(
  carrier: Record<string, string | string[] | undefined> | Headers | null | undefined,
): Context {
  if (!carrier) return context.active();
  const plain: Record<string, string> = {};
  if (typeof (carrier as Headers).forEach === "function" && typeof (carrier as Headers).get === "function") {
    (carrier as Headers).forEach((v, k) => {
      plain[k.toLowerCase()] = v;
    });
  } else {
    for (const [k, v] of Object.entries(carrier as Record<string, string | string[] | undefined>)) {
      if (typeof v === "string") plain[k.toLowerCase()] = v;
      else if (Array.isArray(v) && v[0]) plain[k.toLowerCase()] = v[0];
    }
  }
  return propagation.extract(context.active(), plain);
}

/** The current trace id, for logs and error messages ("trace 4bf9…"). */
export function currentTraceId(): string | undefined {
  const id = trace.getSpan(context.active())?.spanContext().traceId;
  return id && id !== "00000000000000000000000000000000" ? id : undefined;
}
