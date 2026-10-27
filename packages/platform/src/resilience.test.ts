import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError, KeyedLimiter, KeyedRateLimiter } from "./resilience.js";

const transient = (e: unknown) => (e as { status?: number }).status === 503;
const fail = (status: number) => async () => {
  throw Object.assign(new Error(`HTTP ${status}`), { status });
};

describe("circuit breaker", () => {
  it("opens after consecutive transient failures, fails fast, then tries once and closes", async () => {
    let clock = 0;
    const changes: string[] = [];
    const b = new CircuitBreaker("tenant:erp", { failureThreshold: 3, openMs: 10_000, now: () => clock }, (s) =>
      changes.push(s),
    );
    for (let i = 0; i < 2; i++) await expect(b.run(fail(503), transient)).rejects.toThrow("HTTP 503");
    await expect(b.run(fail(404), transient)).rejects.toThrow("HTTP 404"); // the system answered: resets
    for (let i = 0; i < 3; i++) await expect(b.run(fail(503), transient)).rejects.toThrow("HTTP 503");
    expect(b.current).toBe("open");
    let called = false;
    const err = await b.run(async () => (called = true), transient).catch((e) => e);
    expect(called).toBe(false);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.retryAfterMs).toBe(10_000);
    clock += 10_000;
    expect(b.current).toBe("half_open");
    expect(await b.run(async () => "ok", transient)).toBe("ok");
    expect(b.current).toBe("closed");
    expect(changes).toEqual(["open", "half_open", "closed"]);
  });

  it("re-opens when the half-open trial fails, and allows only one trial at a time", async () => {
    let clock = 0;
    const b = new CircuitBreaker("k", { failureThreshold: 1, openMs: 1000, now: () => clock });
    await expect(b.run(fail(503), transient)).rejects.toThrow();
    clock += 1000;
    let release!: () => void;
    const trial = b.run(() => new Promise<string>((r) => (release = () => r("late"))), transient);
    await expect(b.run(async () => 1, transient)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    expect(await trial).toBe("late");
    expect(b.current).toBe("closed");
    await expect(b.run(fail(503), transient)).rejects.toThrow();
    clock += 1000;
    await expect(b.run(fail(503), transient)).rejects.toThrow("HTTP 503");
    expect(b.current).toBe("open");
  });
});

describe("limiters", () => {
  it("caps concurrency per key and in total", () => {
    const l = new KeyedLimiter({ perKey: (k) => (k === "big" ? 3 : 1), total: 3 });
    const a = l.tryAcquire("t1")!;
    expect(l.tryAcquire("t1")).toBeNull();
    const b1 = l.tryAcquire("big")!;
    l.tryAcquire("big");
    expect(l.tryAcquire("big")).toBeNull(); // total reached
    a();
    a(); // idempotent
    expect(l.size).toBe(2);
    expect(l.tryAcquire("t1")).not.toBeNull();
    b1();
  });

  it("rate-limits per key with bursts and refill", () => {
    let clock = 0;
    const r = new KeyedRateLimiter({ rate: () => 2, burst: () => 3, now: () => clock });
    expect([r.take("t"), r.take("t"), r.take("t")]).toEqual([0, 0, 0]);
    expect(r.take("t")).toBe(500);
    expect(r.take("other")).toBe(0);
    clock += 500;
    expect(r.take("t")).toBe(0);
    expect(r.take("t")).toBeGreaterThan(0);
  });
});
