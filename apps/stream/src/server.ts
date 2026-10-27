import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Db } from "@oicr/db";
import {
  ATTR,
  currentTraceId,
  extractContext,
  KeyedLimiter,
  KeyedRateLimiter,
  recordError,
  SpanKind,
  withSpan,
} from "@oicr/platform";
import {
  handleTriggerCall,
  MAX_TRIGGER_BODY_BYTES,
  resolveTriggerRoute,
  TIER_DEFAULTS,
  type TriggerRoute,
  tenantLimits,
} from "@oicr/runtime";
import { sql } from "drizzle-orm";

// The stream engine: serves /t/{org}/{integration}/... for HTTP-triggered
// integrations, apart from the web app. Stateless; any number of replicas.

export interface StreamOptions {
  db: Db;
  /** In-flight requests across all tenants on this instance. */
  maxInFlight?: number;
  /** How long a resolved route is reused before re-reading it. */
  routeTtlMs?: number;
  /** How long "nothing here" is remembered. */
  missTtlMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface CachedRoute {
  route: TriggerRoute | null;
  expires: number;
}

/** Active routes by "org/identifier", with single-flight loading and push invalidation. */
export class RouteCache {
  private readonly entries = new Map<string, CachedRoute>();
  private readonly loading = new Map<string, Promise<TriggerRoute | null>>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number,
    private readonly missTtlMs: number,
  ) {}

  async get(org: string, identifier: string): Promise<TriggerRoute | null> {
    const key = `${org}/${identifier}`;
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.route;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = resolveTriggerRoute(this.db, org, identifier).finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    const route = await pending;
    if (this.entries.size > 100_000) this.entries.clear();
    this.entries.set(key, { route, expires: Date.now() + (route ? this.ttlMs : this.missTtlMs) });
    return route;
  }

  /** An integration changed (activated, deactivated, new token): forget it and every miss. */
  invalidate(integrationId?: string): void {
    for (const [key, v] of this.entries)
      if (!v.route || !integrationId || v.route.integration.id === integrationId) this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  const trace = currentTraceId();
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...(trace ? { "x-trace-id": trace } : {}),
    ...headers,
  });
  res.end(text);
}

export function createStreamServer(opts: StreamOptions): {
  server: Server;
  routes: RouteCache;
  inFlight: () => number;
  drain: (timeoutMs: number) => Promise<void>;
} {
  const { db } = opts;
  const log = opts.log ?? (() => {});
  const routes = new RouteCache(db, opts.routeTtlMs ?? 30_000, opts.missTtlMs ?? 5_000);
  // Limits come from the tenant's tier (cached); these maps hold the current value per tenant.
  const syncLimit = new Map<string, number>();
  const rate = new Map<string, number>();
  const limiter = new KeyedLimiter({
    perKey: (t) => syncLimit.get(t) ?? TIER_DEFAULTS.standard.sync,
    total: opts.maxInFlight ?? 1000,
  });
  const rates = new KeyedRateLimiter({
    rate: (t) => rate.get(t) ?? TIER_DEFAULTS.standard.rps,
    burst: (t) => 2 * (rate.get(t) ?? TIER_DEFAULTS.standard.rps),
  });
  let draining = false;

  async function trigger(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    parts: string[],
    tag: (key: string, value: string) => void,
  ): Promise<void> {
    const [org, identifier, ...rest] = parts;
    if (!org || !identifier)
      return send(res, 404, { error: "not_found", message: "Use /t/{workspace}/{integration}." });
    const route = await routes.get(decodeURIComponent(org), decodeURIComponent(identifier));
    if (!route) return send(res, 404, { error: "not_found", message: "No active integration at this address." });
    const tenant = route.integration.orgId;
    tag(ATTR.tenant, tenant);
    tag(ATTR.integration, route.integration.id);
    tag(ATTR.integrationVersion, route.integration.version);
    const limits = await tenantLimits(db, tenant);
    const tier = TIER_DEFAULTS[limits.tier];
    syncLimit.set(tenant, limits.syncConcurrency ?? tier.sync);
    rate.set(tenant, limits.requestsPerSecond ?? tier.rps);

    const wait = rates.take(tenant);
    if (wait > 0) {
      return send(
        res,
        429,
        { error: "rate_limited", message: "Too many requests for this workspace. Slow down." },
        { "retry-after": String(Math.ceil(wait / 1000)) },
      );
    }
    const release = limiter.tryAcquire(tenant);
    if (!release) {
      return send(
        res,
        429,
        { error: "too_many_in_flight", message: "Too many calls in progress for this workspace. Retry shortly." },
        { "retry-after": "1" },
      );
    }
    try {
      let body = "";
      if (req.method !== "GET" && req.method !== "DELETE" && req.method !== "HEAD") {
        try {
          body = await readBody(req, MAX_TRIGGER_BODY_BYTES);
        } catch (e) {
          if (e instanceof BodyTooLarge)
            return send(res, 413, { error: "too_large", message: "The body is over 10 MB." }, { connection: "close" });
          throw e;
        }
      }
      const r = await handleTriggerCall(db, route, {
        method: req.method ?? "GET",
        path: rest.map(decodeURIComponent),
        header: (name) => {
          const v = req.headers[name.toLowerCase()];
          return Array.isArray(v) ? v[0] : v;
        },
        query: url.searchParams,
        body,
      });
      send(res, r.status, r.body, r.headers);
    } finally {
      release();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://stream");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (url.pathname === "/readyz") {
      if (draining) return send(res, 503, { ok: false, reason: "draining" });
      try {
        await Promise.race([
          db.execute(sql`select 1`),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
        ]);
        return send(res, 200, { ok: true, routes: routes.size, inFlight: limiter.size });
      } catch {
        return send(res, 503, { ok: false, reason: "database" });
      }
    }
    if (parts[0] !== "t") return send(res, 404, { error: "not_found" });
    if (draining)
      return send(
        res,
        503,
        { error: "draining", message: "Shutting down; retry." },
        { connection: "close", "retry-after": "1" },
      );

    await withSpan(
      "http trigger",
      { "http.request.method": req.method, "url.path": url.pathname },
      async (span) => {
        try {
          await trigger(req, res, url, parts.slice(1), (k, v) => span.setAttribute(k, v));
        } catch (e) {
          recordError(span, e);
          log("trigger error", { error: (e as Error).message, path: url.pathname });
          send(res, 500, { error: "internal", message: "Something went wrong. Quote the trace id when reporting it." });
        }
        span.setAttribute("http.response.status_code", res.statusCode);
      },
      { kind: SpanKind.SERVER, parent: extractContext(req.headers) },
    );
    log("request", {
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      ms: Date.now() - started,
      trace: currentTraceId(),
    });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log("unhandled", { error: (e as Error).message });
      send(res, 500, { error: "internal" });
    });
  });
  // Sync runs may take minutes (SYNC_TIMEOUT_SECONDS); headers must arrive fast.
  server.requestTimeout = (Number(process.env.SYNC_TIMEOUT_SECONDS ?? 120) + 15) * 1000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    routes,
    inFlight: () => limiter.size,
    async drain(timeoutMs: number) {
      draining = true;
      server.close();
      const until = Date.now() + timeoutMs;
      while (limiter.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      server.closeAllConnections();
    },
  };
}
