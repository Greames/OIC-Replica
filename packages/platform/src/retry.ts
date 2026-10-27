// Retry policy shared by everything that calls out of the process: connection
// calls, Vault, notifications. Exponential backoff with jitter, a cap per wait,
// an overall deadline, Retry-After honoured, and abort signals respected.

export interface RetryPolicy {
  /** Total attempts, including the first. */
  attempts: number;
  /** Wait before the second attempt, before jitter. */
  baseDelayMs: number;
  /** Cap for any single wait. */
  maxDelayMs: number;
  /** Growth per attempt (default 2). */
  factor?: number;
  /**
   * "equal" (default): half the exponential wait plus a random half, so there
   * is always some wait but clients still spread out. "full": anywhere from 0
   * to the exponential wait. "none": exactly the exponential wait.
   */
  jitter?: "equal" | "full" | "none";
  /** Stop retrying when the next attempt would start later than this after the first one. */
  deadlineMs?: number;
}

export interface RetryHooks {
  signal?: AbortSignal;
  /** Whether an error is worth another attempt. Default: `isTransientError`. */
  isRetryable?(error: unknown, attempt: number): boolean;
  /** A server-requested wait (Retry-After), which overrides a shorter backoff. */
  retryAfterMs?(error: unknown): number | undefined;
  /** Called before each wait; use it to record a span event or a log line. */
  onRetry?(info: { attempt: number; delayMs: number; error: unknown }): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  random?(): number;
  now?(): number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: "equal",
};

/** The wait after `failures` failed attempts (1 = after the first failure). */
export function backoffDelay(failures: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const factor = policy.factor ?? 2;
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * factor ** Math.max(0, failures - 1));
  switch (policy.jitter ?? "equal") {
    case "none":
      return Math.round(exp);
    case "full":
      return Math.round(random() * exp);
    default:
      return Math.round(exp / 2 + random() * (exp / 2));
  }
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
]);

/** HTTP statuses that are safe to retry: timeouts, rate limits and server errors (not 501). */
export function isTransientStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status !== 501 && status !== 505);
}

/**
 * True for errors that a later attempt may not hit: errors marked
 * `retryable`, transient HTTP statuses, network failures and timeouts.
 * A caller's own abort is never transient.
 */
export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    retryable?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    cause?: unknown;
  };
  if (typeof e.retryable === "boolean") return e.retryable;
  if (e.name === "AbortError") return false;
  if (e.name === "TimeoutError") return true;
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (status !== undefined) return isTransientStatus(status);
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  return e.cause !== undefined && e.cause !== error ? isTransientError(e.cause) : false;
}

/** The server-requested wait an error carries, if any (`retryAfterMs`). */
export function retryAfterOf(error: unknown): number | undefined {
  const v = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export class RetryAbortedError extends Error {
  constructor(readonly lastError: unknown) {
    super("Cancelled while waiting to retry.");
    this.name = "AbortError";
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RetryAbortedError(signal.reason));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RetryAbortedError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `fn` until it succeeds, an error is not retryable, attempts run out,
 * or the deadline would be passed. The last error is rethrown unchanged, so
 * callers keep their error types; `attempts` is added to it when possible.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: Partial<RetryPolicy> = {},
  hooks: RetryHooks = {},
): Promise<T> {
  const p: RetryPolicy = { ...DEFAULT_RETRY, ...policy };
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? abortableSleep;
  const isRetryable = hooks.isRetryable ?? ((e: unknown) => isTransientError(e));
  const retryAfter = hooks.retryAfterMs ?? retryAfterOf;
  const started = now();
  for (let attempt = 1; ; attempt++) {
    if (hooks.signal?.aborted) throw new RetryAbortedError(hooks.signal.reason);
    try {
      return await fn(attempt);
    } catch (error) {
      const last = attempt >= p.attempts || !isRetryable(error, attempt) || hooks.signal?.aborted;
      if (!last) {
        const requested = retryAfter(error);
        const delayMs = Math.min(
          Math.max(backoffDelay(attempt, p, hooks.random), requested ?? 0),
          Math.max(p.maxDelayMs, requested ?? 0),
        );
        const overDeadline = p.deadlineMs !== undefined && now() + delayMs - started > p.deadlineMs;
        if (!overDeadline) {
          hooks.onRetry?.({ attempt, delayMs, error });
          await sleep(delayMs, hooks.signal);
          continue;
        }
      }
      if (error && typeof error === "object" && !("attempts" in error)) {
        try {
          Object.defineProperty(error, "attempts", { value: attempt, enumerable: false });
        } catch {
          // Frozen errors keep their shape.
        }
      }
      throw error;
    }
  }
}
