import { readFileSync } from "node:fs";
import { ATTR, isTransientStatus, parseRetryAfter, type RetryPolicy, retry, SpanKind, withSpan } from "@oicr/platform";
import { Agent, type Dispatcher, fetch } from "undici";
import { assertRef, type SecretRef, type SecretStore, SecretStoreError, type SecretValue } from "./store.js";

// HashiCorp Vault (or OpenBao) over its HTTP API. Secrets are kept in a KV v2
// engine at {mount}/data/tenants/{tenant}/{kind}/{id}; the platform's policy
// should grant only that prefix:
//
//   path "oicr/data/tenants/*"     { capabilities = ["create", "update", "read"] }
//   path "oicr/metadata/tenants/*" { capabilities = ["delete", "list"] }
//
// Authentication, in order of preference for production:
//   kubernetes  VAULT_K8S_ROLE (+ VAULT_K8S_MOUNT, service account token file)
//   approle     VAULT_ROLE_ID + VAULT_SECRET_ID (or VAULT_SECRET_ID_FILE)
//   token       VAULT_TOKEN or VAULT_TOKEN_FILE
// Tokens are renewed before they expire; a login token is re-acquired on 403.

export type VaultAuth =
  | { method: "token"; token?: string; tokenFile?: string }
  | { method: "approle"; roleId: string; secretId?: string; secretIdFile?: string; mount?: string }
  | { method: "kubernetes"; role: string; jwtFile?: string; mount?: string };

export interface VaultOptions {
  address: string;
  auth: VaultAuth;
  /** KV v2 mount (default "oicr"). */
  mount?: string;
  /** Enterprise / HCP namespace sent as X-Vault-Namespace. */
  namespace?: string;
  /** PEM CA bundle for a private CA. */
  caCert?: string;
  /** Per request (default 5000 ms). */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Renew when less than this fraction of the token's TTL is left (default 1/3). */
  renewFraction?: number;
  now?: () => number;
}

interface TokenState {
  token: string;
  /** ms epoch; Infinity for non-expiring tokens. */
  expiresAt: number;
  ttlMs: number;
  renewable: boolean;
}

interface VaultResponse {
  status: number;
  body: Record<string, unknown> | null;
  retryAfterMs?: number;
}

const DEFAULT_RETRY: Partial<RetryPolicy> = { attempts: 4, baseDelayMs: 100, maxDelayMs: 2000, deadlineMs: 10_000 };

class VaultHttpError extends Error {
  constructor(
    readonly status: number,
    readonly errors: string[],
    readonly retryAfterMs?: number,
  ) {
    super(`Vault answered ${status}${errors.length ? `: ${errors.join("; ")}` : ""}`);
  }
  get retryable() {
    return isTransientStatus(this.status);
  }
}

export class VaultClient {
  private state: TokenState | null = null;
  private pendingAuth: Promise<TokenState> | null = null;
  private readonly dispatcher?: Dispatcher;
  private readonly now: () => number;

  constructor(readonly opts: VaultOptions) {
    if (!/^https?:\/\//.test(opts.address))
      throw new SecretStoreError("misconfigured", "VAULT_ADDR must be an http(s) URL.");
    this.now = opts.now ?? Date.now;
    if (opts.caCert) this.dispatcher = new Agent({ connect: { ca: opts.caCert } });
  }

  private url(path: string) {
    return `${this.opts.address.replace(/\/$/, "")}/v1/${path.replace(/^\//, "")}`;
  }

  /** One HTTP call, without auth handling. Network errors and 5xx/429 are retried by callers. */
  private async raw(method: string, path: string, token: string | null, body?: unknown): Promise<VaultResponse> {
    const headers: Record<string, string> = { "x-vault-request": "true" };
    if (token) headers["x-vault-token"] = token;
    if (this.opts.namespace) headers["x-vault-namespace"] = this.opts.namespace;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(this.url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      throw Object.assign(new Error(`Vault is unreachable: ${err.cause?.code ?? err.name}`), {
        retryable: true,
        cause: e,
      });
    }
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, body: parsed, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
  }

  private fail(res: VaultResponse): never {
    const errors = Array.isArray(res.body?.errors) ? (res.body.errors as unknown[]).map(String) : [];
    throw new VaultHttpError(res.status, errors, res.retryAfterMs);
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return retry(fn, { ...DEFAULT_RETRY, ...this.opts.retry });
  }

  private readFileTrim(path: string, what: string): string {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      throw new SecretStoreError("misconfigured", `Cannot read ${what} from ${path}.`);
    }
  }

  private tokenState(token: string, ttlSeconds: number, renewable: boolean): TokenState {
    const ttlMs = ttlSeconds * 1000;
    return { token, ttlMs, renewable, expiresAt: ttlSeconds > 0 ? this.now() + ttlMs : Number.POSITIVE_INFINITY };
  }

  private async login(): Promise<TokenState> {
    const auth = this.opts.auth;
    if (auth.method === "token") {
      const token = auth.token || (auth.tokenFile ? this.readFileTrim(auth.tokenFile, "the Vault token") : "");
      if (!token) throw new SecretStoreError("misconfigured", "Set VAULT_TOKEN or VAULT_TOKEN_FILE.");
      const res = await this.withRetry(() =>
        this.raw("GET", "auth/token/lookup-self", token).then((r) =>
          r.status >= 500 || r.status === 429 ? this.fail(r) : r,
        ),
      );
      if (res.status === 403)
        throw new SecretStoreError("forbidden", "Vault rejected the token (expired or revoked).", 403);
      if (res.status !== 200) this.fail(res);
      const data = (res.body?.data ?? {}) as { ttl?: number; renewable?: boolean };
      return this.tokenState(token, Number(data.ttl ?? 0), Boolean(data.renewable));
    }
    const [path, payload] =
      auth.method === "approle"
        ? [
            `auth/${auth.mount ?? "approle"}/login`,
            {
              role_id: auth.roleId,
              secret_id:
                auth.secretId ||
                (auth.secretIdFile ? this.readFileTrim(auth.secretIdFile, "the AppRole secret id") : ""),
            },
          ]
        : [
            `auth/${auth.mount ?? "kubernetes"}/login`,
            {
              role: auth.role,
              jwt: this.readFileTrim(
                auth.jwtFile ?? "/var/run/secrets/kubernetes.io/serviceaccount/token",
                "the service account token",
              ),
            },
          ];
    const res = await this.withRetry(() =>
      this.raw("POST", path, null, payload).then((r) => (r.status >= 500 || r.status === 429 ? this.fail(r) : r)),
    );
    if (res.status === 400 || res.status === 403)
      throw new SecretStoreError("forbidden", `Vault ${auth.method} login was refused.`, res.status);
    if (res.status !== 200) this.fail(res);
    const a = (res.body?.auth ?? {}) as { client_token?: string; lease_duration?: number; renewable?: boolean };
    if (!a.client_token) throw new SecretStoreError("unavailable", "Vault login returned no token.");
    return this.tokenState(a.client_token, Number(a.lease_duration ?? 0), Boolean(a.renewable));
  }

  private async renew(state: TokenState): Promise<TokenState> {
    const res = await this.raw("POST", "auth/token/renew-self", state.token, {});
    if (res.status !== 200) return this.login();
    const a = (res.body?.auth ?? {}) as { lease_duration?: number; renewable?: boolean };
    return this.tokenState(state.token, Number(a.lease_duration ?? 0), Boolean(a.renewable));
  }

  /** A valid token, logging in or renewing as needed. Concurrent callers share one attempt. */
  async token(force = false): Promise<string> {
    const s = this.state;
    const fraction = this.opts.renewFraction ?? 1 / 3;
    const fresh =
      s && !force && (s.expiresAt === Number.POSITIVE_INFINITY || s.expiresAt - this.now() > s.ttlMs * fraction);
    if (fresh) return s.token;
    if (!this.pendingAuth) {
      this.pendingAuth = (async () => {
        try {
          if (s && !force && s.renewable && s.expiresAt > this.now()) return await this.renew(s);
          return await this.login();
        } finally {
          this.pendingAuth = null;
        }
      })().then((next) => {
        this.state = next;
        return next;
      });
    }
    return (await this.pendingAuth).token;
  }

  /**
   * An authenticated call. 5xx, 429 and network errors are retried with
   * backoff; a 403 on a login-based token triggers one fresh login.
   */
  async call(method: string, path: string, body?: unknown, okStatuses: number[] = [200, 204]): Promise<VaultResponse> {
    const once = async (force: boolean) => {
      const token = await this.token(force);
      return this.withRetry(async () => {
        const res = await this.raw(method, path, token, body);
        if (isTransientStatus(res.status)) this.fail(res);
        return res;
      });
    };
    try {
      let res = await once(false);
      if (res.status === 403 && this.opts.auth.method !== "token") res = await once(true);
      if (okStatuses.includes(res.status)) return res;
      if (res.status === 403)
        throw new SecretStoreError("forbidden", "Vault denied access. Check the platform's Vault policy.", 403);
      return res;
    } catch (e) {
      if (e instanceof SecretStoreError) throw e;
      const status = (e as { status?: number }).status;
      throw new SecretStoreError("unavailable", (e as Error).message, status);
    }
  }
}

/** KV v2 SecretStore on Vault. */
export class VaultSecretStore implements SecretStore {
  readonly backend = "vault";
  private readonly mount: string;

  constructor(readonly client: VaultClient) {
    this.mount = (client.opts.mount ?? "oicr").replace(/^\/|\/$/g, "");
  }

  private path(ref: SecretRef, area: "data" | "metadata") {
    assertRef(ref);
    return `${this.mount}/${area}/tenants/${ref.tenant}/${ref.kind}/${ref.id}`;
  }

  private span<T>(op: string, ref: SecretRef | null, fn: () => Promise<T>) {
    return withSpan(
      `vault ${op}`,
      { [ATTR.secretBackend]: "vault", [ATTR.secretKind]: ref?.kind, [ATTR.tenant]: ref?.tenant },
      fn,
      { kind: SpanKind.CLIENT },
    );
  }

  put(ref: SecretRef, value: SecretValue): Promise<void> {
    return this.span("write", ref, async () => {
      const res = await this.client.call("POST", this.path(ref, "data"), { data: value });
      if (res.status !== 200 && res.status !== 204)
        throw new SecretStoreError("unavailable", `Vault refused the write (${res.status}).`, res.status);
    });
  }

  get<T extends SecretValue = SecretValue>(ref: SecretRef): Promise<T | null> {
    return this.span("read", ref, async () => {
      const res = await this.client.call("GET", this.path(ref, "data"), undefined, [200, 404]);
      if (res.status === 404) return null;
      if (res.status !== 200)
        throw new SecretStoreError("unavailable", `Vault refused the read (${res.status}).`, res.status);
      const data = (res.body?.data as { data?: unknown } | undefined)?.data;
      return data && typeof data === "object" ? (data as T) : null;
    });
  }

  delete(ref: SecretRef): Promise<void> {
    return this.span("delete", ref, async () => {
      const res = await this.client.call("DELETE", this.path(ref, "metadata"), undefined, [200, 204, 404]);
      if (![200, 204, 404].includes(res.status))
        throw new SecretStoreError("unavailable", `Vault refused the delete (${res.status}).`, res.status);
    });
  }

  /** Lists and deletes every secret under tenants/{tenant}/ (KV v2 has no recursive delete). */
  deleteTenant(tenant: string): Promise<number> {
    assertRef({ tenant, kind: "connection", id: "x" });
    return this.span("delete tenant", { tenant, kind: "connection", id: "*" }, async () => {
      const list = async (path: string): Promise<string[]> => {
        const res = await this.client.call("LIST", `${this.mount}/metadata/${path}`, undefined, [200, 404]);
        if (res.status === 404) return [];
        const keys = (res.body?.data as { keys?: unknown } | undefined)?.keys;
        return Array.isArray(keys) ? keys.map(String) : [];
      };
      let removed = 0;
      const walk = async (path: string) => {
        for (const key of await list(path)) {
          if (key.endsWith("/")) await walk(`${path}${key}`);
          else {
            const res = await this.client.call(
              "DELETE",
              `${this.mount}/metadata/${path}${key}`,
              undefined,
              [200, 204, 404],
            );
            if (res.status !== 404) removed++;
          }
        }
      };
      await walk(`tenants/${tenant}/`);
      return removed;
    });
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    const probe: SecretRef = { tenant: "healthcheck", kind: "connection", id: "probe" };
    try {
      await this.put(probe, { at: new Date().toISOString() });
      await this.get(probe);
      await this.delete(probe);
      return { ok: true, message: `Vault at ${this.client.opts.address}, KV v2 mount "${this.mount}".` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}

/** Vault settings from the environment, or null when VAULT_ADDR is not set. */
export function vaultOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): VaultOptions | null {
  const address = env.VAULT_ADDR;
  if (!address) return null;
  const auth: VaultAuth = env.VAULT_K8S_ROLE
    ? { method: "kubernetes", role: env.VAULT_K8S_ROLE, jwtFile: env.VAULT_K8S_JWT_FILE, mount: env.VAULT_K8S_MOUNT }
    : env.VAULT_ROLE_ID
      ? {
          method: "approle",
          roleId: env.VAULT_ROLE_ID,
          secretId: env.VAULT_SECRET_ID,
          secretIdFile: env.VAULT_SECRET_ID_FILE,
          mount: env.VAULT_APPROLE_MOUNT,
        }
      : { method: "token", token: env.VAULT_TOKEN, tokenFile: env.VAULT_TOKEN_FILE };
  let caCert: string | undefined;
  if (env.VAULT_CACERT) {
    try {
      caCert = readFileSync(env.VAULT_CACERT, "utf8");
    } catch {
      throw new SecretStoreError("misconfigured", `Cannot read VAULT_CACERT (${env.VAULT_CACERT}).`);
    }
  }
  return {
    address,
    auth,
    mount: env.VAULT_KV_MOUNT || "oicr",
    namespace: env.VAULT_NAMESPACE || undefined,
    caCert,
    timeoutMs: env.VAULT_TIMEOUT_MS ? Number(env.VAULT_TIMEOUT_MS) : undefined,
  };
}
