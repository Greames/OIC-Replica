// Where customer credentials live. The primary database only ever holds a
// reference ({ tenant, kind, id }); the values sit in a SecretStore.

export const SECRET_KINDS = ["connection", "channel"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretRef {
  /** The tenant (organization id). Part of the path, so tenants never share a key. */
  tenant: string;
  kind: SecretKind;
  /** The owning object's id. */
  id: string;
}

export type SecretValue = Record<string, unknown>;

export interface SecretStore {
  readonly backend: string;
  /** Writes a new version (Vault keeps history for rotation and audit). */
  put(ref: SecretRef, value: SecretValue): Promise<void>;
  /** The current value, or null when there is none. */
  get<T extends SecretValue = SecretValue>(ref: SecretRef): Promise<T | null>;
  /** Removes every version. Missing secrets are not an error. */
  delete(ref: SecretRef): Promise<void>;
  /** Whether the store is reachable and writable by this service. */
  check(): Promise<{ ok: boolean; message: string }>;
}

export type SecretErrorKind = "unavailable" | "forbidden" | "invalid" | "misconfigured";

/** A store failure. Messages never contain secret values. */
export class SecretStoreError extends Error {
  constructor(
    readonly kind: SecretErrorKind,
    message: string,
    readonly status?: number,
    readonly retryable = kind === "unavailable",
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Validates a reference so it can never escape its tenant's path. */
export function assertRef(ref: SecretRef): void {
  if (!SAFE.test(ref.tenant)) throw new SecretStoreError("invalid", "Invalid tenant id for a secret.");
  if (!SAFE.test(ref.id)) throw new SecretStoreError("invalid", "Invalid object id for a secret.");
  if (!(SECRET_KINDS as readonly string[]).includes(ref.kind))
    throw new SecretStoreError("invalid", `Unknown secret kind "${ref.kind}".`);
}

export const refKey = (ref: SecretRef) => `${ref.tenant}/${ref.kind}/${ref.id}`;

/**
 * Keeps recently read secrets in memory for a short time so hot paths (the
 * stream engine, delivery workers) do not pay a round trip per request.
 * Writes and deletes through this wrapper invalidate their entry at once;
 * other processes see a change within `ttlMs`.
 */
export function cachedStore(
  inner: SecretStore,
  opts: { ttlMs: number; maxEntries?: number; now?: () => number },
): SecretStore {
  if (opts.ttlMs <= 0) return inner;
  const max = opts.maxEntries ?? 10_000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: SecretValue | null; expires: number }>();
  const inflight = new Map<string, Promise<SecretValue | null>>();
  const copy = <T>(v: T): T => (v === null ? v : structuredClone(v));
  return {
    backend: inner.backend,
    async put(ref, value) {
      entries.delete(refKey(ref));
      await inner.put(ref, value);
      entries.delete(refKey(ref));
    },
    async get<T extends SecretValue>(ref: SecretRef): Promise<T | null> {
      const key = refKey(ref);
      const hit = entries.get(key);
      if (hit && hit.expires > now()) return copy(hit.value) as T | null;
      let pending = inflight.get(key);
      if (!pending) {
        pending = inner.get(ref).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      const value = await pending;
      if (entries.size >= max) entries.delete(entries.keys().next().value as string);
      entries.set(key, { value, expires: now() + opts.ttlMs });
      return copy(value) as T | null;
    },
    async delete(ref) {
      entries.delete(refKey(ref));
      await inner.delete(ref);
      entries.delete(refKey(ref));
    },
    check: () => inner.check(),
  };
}

/** For tests and tools: a store held in memory. */
export function memoryStore(): SecretStore & { size(): number } {
  const data = new Map<string, SecretValue>();
  return {
    backend: "memory",
    async put(ref, value) {
      assertRef(ref);
      data.set(refKey(ref), structuredClone(value));
    },
    async get<T extends SecretValue>(ref: SecretRef) {
      assertRef(ref);
      const v = data.get(refKey(ref));
      return v ? (structuredClone(v) as T) : null;
    },
    async delete(ref) {
      assertRef(ref);
      data.delete(refKey(ref));
    },
    async check() {
      return { ok: true, message: "In-memory store." };
    },
    size: () => data.size,
  };
}
