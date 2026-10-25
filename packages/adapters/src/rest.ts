import { request as httpRequest } from "undici";
import { z } from "zod";
import { assertPublicUrl, dispatcher } from "./network.js";
import { type Adapter, AdapterError, type ConnectionConfig, type TestResult } from "./types.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

export const RestProperties = z.object({
  baseUrl: z
    .string()
    .url("Enter a full URL, like https://api.example.com/v1")
    .refine((u) => /^https?:\/\//.test(u), "Use http:// or https://"),
  headers: z.record(z.string(), z.string()).default({}),
  testPath: z.string().startsWith("/").default("/"),
  timeoutSeconds: z.coerce.number().int().min(1).max(300).default(30),
  apiKeyHeader: z.string().min(1).default("X-API-Key"),
});
export type RestProperties = z.infer<typeof RestProperties>;

const Secret = {
  basic: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  api_key: z.object({ apiKey: z.string().min(1) }),
  bearer: z.object({ token: z.string().min(1) }),
};

const RequestShape = z.object({
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function parseOperation(operation: string): { method: (typeof METHODS)[number]; path: string } {
  const m = operation.trim().match(/^([A-Za-z]+)\s+(\/\S*)$/);
  const method = m?.[1]?.toUpperCase();
  if (!m || !method || !(METHODS as readonly string[]).includes(method)) {
    throw new AdapterError(
      "invalid_operation",
      `REST operations look like "POST /orders" or "GET /orders/{id}". Got "${operation}".`,
    );
  }
  return { method: method as (typeof METHODS)[number], path: m[2] ?? "/" };
}

function authHeaders(conn: ConnectionConfig, props: RestProperties): Record<string, string> {
  const s = conn.secret ?? {};
  switch (conn.authType) {
    case "basic": {
      const { username, password } = Secret.basic.parse(s);
      return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
    }
    case "api_key":
      return { [props.apiKeyHeader.toLowerCase()]: Secret.api_key.parse(s).apiKey };
    case "bearer":
      return { authorization: `Bearer ${Secret.bearer.parse(s).token}` };
    default:
      return {};
  }
}

function buildUrl(baseUrl: string, path: string, params: Record<string, unknown>, query: Record<string, unknown>): URL {
  const filled = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || v === "") {
      throw new AdapterError("missing_path_param", `The path needs "${name}". Add it under request.params.`);
    }
    return encodeURIComponent(String(v));
  });
  const url = new URL(baseUrl.replace(/\/+$/, "") + filled);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
  }
  return url;
}

async function send(
  conn: ConnectionConfig,
  method: string,
  path: string,
  req: z.infer<typeof RequestShape>,
  signal?: AbortSignal,
): Promise<RestResponse> {
  const props = RestProperties.parse(conn.properties);
  const url = buildUrl(props.baseUrl, path, req.params ?? {}, req.query ?? {});
  assertPublicUrl(url);

  const headers: Record<string, string> = { accept: "application/json, */*;q=0.5" };
  for (const [k, v] of Object.entries({ ...props.headers, ...req.headers })) headers[k.toLowerCase()] = v;
  Object.assign(headers, authHeaders(conn, props));

  let body: string | undefined;
  if (req.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (typeof req.body === "string") {
      body = req.body;
      headers["content-type"] ??= "text/plain; charset=utf-8";
    } else {
      body = JSON.stringify(req.body);
      headers["content-type"] ??= "application/json";
    }
  }

  const timeout = AbortSignal.timeout(props.timeoutSeconds * 1000);
  let res: Awaited<ReturnType<typeof httpRequest>>;
  try {
    res = await httpRequest(url, {
      method: method as "GET",
      headers,
      body,
      dispatcher: dispatcher(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      maxRedirections: 0,
    } as Parameters<typeof httpRequest>[1]);
  } catch (e) {
    throw networkError(e, url, props.timeoutSeconds);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      res.body.destroy();
      throw new AdapterError("response_too_large", `The response is over ${MAX_RESPONSE_BYTES / 1024 / 1024} MB.`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const resHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v !== undefined) resHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  let parsed: unknown = text;
  if (text && /json/i.test(resHeaders["content-type"] ?? "")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (text === "") parsed = null;
  return { status: res.statusCode, headers: resHeaders, body: parsed };
}

function networkError(e: unknown, url: URL, timeoutSeconds: number): AdapterError {
  const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e instanceof AdapterError) return e;
  const code = err.cause?.code ?? err.code;
  if (code === "EBLOCKED" || err.cause?.message?.includes("blocked private address")) {
    return new AdapterError(
      "private_network",
      `${url.hostname} resolves to a private address. Connections can only reach public endpoints.`,
    );
  }
  if (err.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return new AdapterError("timeout", `${url.host} did not answer within ${timeoutSeconds} s.`, undefined, true);
  }
  if (err.name === "AbortError") return new AdapterError("aborted", "The call was cancelled.");
  if (code === "ENOTFOUND") return new AdapterError("dns", `${url.hostname} could not be found. Check the base URL.`);
  if (code === "ECONNREFUSED") {
    return new AdapterError("connection_refused", `${url.host} refused the connection.`, undefined, true);
  }
  return new AdapterError(
    "network",
    `Could not reach ${url.host}: ${err.cause?.message ?? err.message}`,
    undefined,
    true,
  );
}

function excerpt(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s && s.length > 300 ? `${s.slice(0, 300)}…` : (s ?? "");
}

export const rest: Adapter<RestProperties> = {
  id: "rest",
  name: "REST API",
  description: "Call any HTTP/JSON API, or receive calls from one.",
  roles: ["trigger", "invoke"],
  authTypes: ["none", "basic", "api_key", "bearer"],
  properties: RestProperties,
  operationHelp:
    'Operation: "METHOD /path", e.g. "POST /orders" or "GET /orders/{id}". The step\'s request expression returns { "params": {...}, "query": {...}, "headers": {...}, "body": ... }; {name} in the path comes from params. Output: { "status", "headers", "body" }. Non-2xx responses fail the step with $fault.code "http_<status>".',
  fields: [
    { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://api.example.com/v1" },
    {
      key: "testPath",
      label: "Test path",
      type: "text",
      placeholder: "/",
      help: "A GET path used by Test, e.g. /health or /me.",
    },
    { key: "timeoutSeconds", label: "Timeout (seconds)", type: "number", placeholder: "30" },
    { key: "headers", label: "Default headers", type: "keyvalue" },
    { key: "username", label: "Username", type: "text", required: true, authTypes: ["basic"], secret: true },
    { key: "password", label: "Password", type: "password", required: true, authTypes: ["basic"], secret: true },
    {
      key: "apiKeyHeader",
      label: "API key header",
      type: "text",
      placeholder: "X-API-Key",
      authTypes: ["api_key"],
    },
    { key: "apiKey", label: "API key", type: "password", required: true, authTypes: ["api_key"], secret: true },
    { key: "token", label: "Bearer token", type: "password", required: true, authTypes: ["bearer"], secret: true },
  ],

  async test(conn): Promise<TestResult> {
    try {
      const props = RestProperties.parse(conn.properties);
      const res = await send(conn, "GET", props.testPath, {});
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Reached the API, but it rejected the credentials (${res.status}).` };
      }
      if (res.status >= 500) return { ok: false, message: `The API answered with a server error (${res.status}).` };
      if (res.status === 404) {
        return {
          ok: true,
          message: `Reached the API. ${props.testPath} returned 404, so set a test path that exists to check credentials too.`,
        };
      }
      return { ok: true, message: `Connected. GET ${props.testPath} returned ${res.status}.` };
    } catch (e) {
      if (e instanceof z.ZodError) return { ok: false, message: e.issues[0]?.message ?? "Check the settings." };
      return { ok: false, message: (e as Error).message };
    }
  },

  async invoke(conn, { operation, request, signal }) {
    const { method, path } = parseOperation(operation);
    const shaped =
      request &&
      typeof request === "object" &&
      !Array.isArray(request) &&
      Object.keys(request).some((k) => ["params", "query", "headers", "body"].includes(k))
        ? request
        : request === undefined || request === null
          ? {}
          : { body: request };
    const parsed = RequestShape.safeParse(shaped);
    if (!parsed.success) {
      throw new AdapterError("invalid_request", `The request is not valid: ${parsed.error.issues[0]?.message}`);
    }
    const res = await send(conn, method, path, parsed.data, signal);
    if (res.status < 200 || res.status >= 300) {
      throw new AdapterError(
        `http_${res.status}`,
        `${method} ${path} returned ${res.status}: ${excerpt(res.body)}`,
        { status: res.status, body: res.body },
        res.status === 429 || res.status >= 500,
      );
    }
    return res;
  },
};
