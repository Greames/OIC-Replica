import { SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTR,
  backoffDelay,
  currentTraceId,
  extractContext,
  injectContext,
  isTransientError,
  parseRetryAfter,
  retry,
  withSpan,
} from "./index.js";
import { startTestTelemetry } from "./otel.js";

const { exporter } = startTestTelemetry();
beforeEach(() => exporter.reset());

describe("backoff", () => {
  const p = { attempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
  it("grows exponentially, is capped, and jitters inside its band", () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(n, { ...p, jitter: "none" }))).toEqual([100, 200, 400, 800, 1000]);
    expect(backoffDelay(3, p, () => 0)).toBe(200);
    expect(backoffDelay(3, p, () => 1)).toBe(400);
    expect(backoffDelay(3, { ...p, jitter: "full" }, () => 0)).toBe(0);
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(10_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("classifies transient errors", () => {
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 501 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
    expect(isTransientError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientError(new Error("x", { cause: { code: "UND_ERR_SOCKET" } }))).toBe(true);
    expect(isTransientError({ name: "AbortError" })).toBe(false);
    expect(isTransientError({ name: "TimeoutError" })).toBe(true);
    expect(isTransientError({ retryable: false, status: 503 })).toBe(false);
  });
});

describe("retry", () => {
  const fast = { sleep: async () => {}, random: () => 1 };

  it("retries transient failures with growing waits, then succeeds", async () => {
    const waits: number[] = [];
    let n = 0;
    const r = await retry(
      async (attempt) => {
        n = attempt;
        if (attempt < 3) throw Object.assign(new Error("busy"), { status: 503 });
        return "ok";
      },
      { attempts: 5, baseDelayMs: 100, maxDelayMs: 1000 },
      { ...fast, onRetry: (i) => waits.push(i.delayMs) },
    );
    expect(r).toBe("ok");
    expect(n).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("stops at once on permanent errors and when attempts run out, keeping the error", async () => {
    let calls = 0;
    const bad = Object.assign(new Error("no"), { status: 400 });
    await expect(
      retry(
        async () => {
          calls++;
          throw bad;
        },
        { attempts: 5 },
        fast,
      ),
    ).rejects.toBe(bad);
    expect(calls).toBe(1);
    calls = 0;
    const err = await retry(
      async () => {
        calls++;
        throw Object.assign(new Error("down"), { status: 502 });
      },
      { attempts: 3 },
      fast,
    ).catch((e) => e);
    expect(calls).toBe(3);
    expect(err.attempts).toBe(3);
  });

  it("honours Retry-After over a shorter backoff, and the deadline", async () => {
    const waits: number[] = [];
    await retry(
      async (a) => {
        if (a === 1) throw Object.assign(new Error("slow down"), { status: 429, retryAfterMs: 5000 });
        return 1;
      },
      { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      { ...fast, onRetry: (i) => waits.push(i.delayMs) },
    );
    expect(waits).toEqual([5000]);
    let clock = 0;
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw Object.assign(new Error("x"), { status: 503 });
        },
        { attempts: 10, baseDelayMs: 1000, maxDelayMs: 1000, jitter: "none", deadlineMs: 2500 },
        {
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
      ),
    ).rejects.toThrow("x");
    expect(calls).toBe(3);
  });

  it("stops waiting when aborted", async () => {
    const ac = new AbortController();
    const p = retry(
      async () => {
        throw Object.assign(new Error("x"), { status: 503 });
      },
      { attempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000 },
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("tracing", () => {
  it("nests spans, records errors, and carries context through W3C headers", async () => {
    let carrier: Record<string, string> = {};
    await withSpan("run", { [ATTR.tenant]: "t1", [ATTR.run]: undefined }, async () => {
      await withSpan("step invoke", { [ATTR.step]: "get" }, async () => {
        expect(currentTraceId()).toMatch(/^[0-9a-f]{32}$/);
        carrier = injectContext();
      });
      await expect(
        withSpan("step fail", {}, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });
    // A queued job continues the same trace.
    await withSpan("worker", {}, async () => {}, { parent: extractContext(carrier) });

    const spans = exporter.getFinishedSpans();
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    const run = byName.run!;
    expect(run.attributes).toEqual({ [ATTR.tenant]: "t1" });
    expect(byName["step invoke"]!.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(byName["step fail"]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(byName["step fail"]!.events[0]?.name).toBe("exception");
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(byName.worker!.spanContext().traceId).toBe(run.spanContext().traceId);
    expect(byName.worker!.parentSpanContext?.spanId).toBe(byName["step invoke"]!.spanContext().spanId);
  });
});
