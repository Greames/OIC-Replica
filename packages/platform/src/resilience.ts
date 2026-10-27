// In-process resilience primitives for the data plane. They are per replica
// by design: each stream engine or worker protects itself and the systems it
// calls; nothing here needs coordination to be safe.

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  /** Consecutive transient failures that open the circuit. */
  failureThreshold?: number;
  /** How long it stays open before letting one trial call through. */
  openMs?: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  readonly retryable = true;
  constructor(
    readonly key: string,
    readonly retryAfterMs: number,
  ) {
    super(`Calls to ${key} are paused for ${Math.ceil(retryAfterMs / 1000)} s after repeated failures.`);
    this.name = "CircuitOpenError";
  }
}

/**
 * A circuit breaker: after `failureThreshold` consecutive transient failures
 * it fails fast for `openMs`, then lets a single trial through (half-open);
 * success closes it, failure re-opens it. Permanent errors (4xx) do not count:
 * the system answered, it is not down.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(
    readonly key: string,
    opts: BreakerOptions = {},
    private readonly onChange?: (state: BreakerState, key: string) => void,
  ) {
    this.threshold = opts.failureThreshold ?? 5;
    this.openMs = opts.openMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  get current(): BreakerState {
    if (this.state === "open" && this.now() - this.openedAt >= this.openMs) return "half_open";
    return this.state;
  }

  private set(state: BreakerState) {
    if (this.state === state) return;
    this.state = state;
    this.onChange?.(state, this.key);
  }

  /** Throws CircuitOpenError instead of calling while open; otherwise runs `fn` and learns from it. */
  async run<T>(fn: () => Promise<T>, isFailure: (e: unknown) => boolean): Promise<T> {
    const state = this.current;
    if (state === "open") throw new CircuitOpenError(this.key, this.openMs - (this.now() - this.openedAt));
    if (state === "half_open") {
      if (this.trialInFlight) throw new CircuitOpenError(this.key, 1000);
      this.trialInFlight = true;
      this.set("half_open");
    }
    try {
      const out = await fn();
      this.failures = 0;
      this.set("closed");
      return out;
    } catch (e) {
      if (isFailure(e)) {
        this.failures++;
        if (state === "half_open" || this.failures >= this.threshold) {
          this.openedAt = this.now();
          this.set("open");
        }
      } else {
        this.failures = 0;
        this.set("closed");
      }
      throw e;
    } finally {
      if (state === "half_open") this.trialInFlight = false;
    }
  }
}

/** Breakers by key (e.g. tenant + connection), created on first use, bounded in number. */
export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  constructor(
    private readonly opts: BreakerOptions & { maxEntries?: number } = {},
    private readonly onChange?: (state: BreakerState, key: string) => void,
  ) {}

  get(key: string): CircuitBreaker {
    let b = this.breakers.get(key);
    if (!b) {
      if (this.breakers.size >= (this.opts.maxEntries ?? 10_000)) {
        // Drop the oldest closed breaker; open ones carry state worth keeping.
        for (const [k, v] of this.breakers)
          if (v.current === "closed") {
            this.breakers.delete(k);
            break;
          }
      }
      b = new CircuitBreaker(key, this.opts, this.onChange);
      this.breakers.set(key, b);
    }
    return b;
  }
}

/** Caps concurrent work per key (a bulkhead per tenant). */
export class KeyedLimiter {
  private readonly inFlight = new Map<string, number>();
  private total = 0;

  constructor(private readonly opts: { perKey: (key: string) => number; total: number }) {}

  /** A release function, or null when the key (or the whole limiter) is at capacity. */
  tryAcquire(key: string): (() => void) | null {
    const n = this.inFlight.get(key) ?? 0;
    if (n >= this.opts.perKey(key) || this.total >= this.opts.total) return null;
    this.inFlight.set(key, n + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, left);
    };
  }

  get size() {
    return this.total;
  }
}

/** A token bucket per key: `rate` per second, bursts up to `burst`. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      rate: (key: string) => number;
      burst: (key: string) => number;
      now?: () => number;
      maxEntries?: number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** 0 when allowed (and a token is taken); otherwise ms until one is available. */
  take(key: string): number {
    const rate = this.opts.rate(key);
    const burst = this.opts.burst(key);
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= (this.opts.maxEntries ?? 50_000))
        this.buckets.delete(this.buckets.keys().next().value as string);
      b = { tokens: burst, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * rate);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) / rate) * 1000);
  }
}
