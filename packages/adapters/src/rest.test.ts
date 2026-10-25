import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdapterError, type ConnectionConfig, isBlockedAddress, parseOperation, rest } from "./index.js";

let server: Server;
let base: string;
const seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/me") {
        if (req.headers.authorization !== `Basic ${Buffer.from("ada:secret").toString("base64")}`) {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end('{"name":"ada"}');
      } else if (url.pathname === "/orders" && req.method === "POST") {
        res
          .writeHead(201, { "content-type": "application/json" })
          .end(JSON.stringify({ id: 7, got: JSON.parse(body) }));
      } else if (url.pathname.startsWith("/orders/")) {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id: url.pathname.split("/")[2], q: url.search }));
      } else if (url.pathname === "/boom") {
        res.writeHead(503, { "content-type": "application/json" }).end('{"error":"down"}');
      } else if (url.pathname === "/bad") {
        res.writeHead(422, { "content-type": "application/json" }).end('{"error":"total must be positive"}');
      } else if (url.pathname === "/slow") {
        setTimeout(() => res.writeHead(200).end("late"), 1500);
      } else if (url.pathname === "/text") {
        res.writeHead(200, { "content-type": "text/plain" }).end("hello");
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ALLOW_PRIVATE_NETWORK = "true";
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  seen.length = 0;
  process.env.ALLOW_PRIVATE_NETWORK = "true";
});

const unexpected = (): never => {
  throw new Error("expected the call to fail");
};
const asAdapterError = (e: unknown) => e as AdapterError;

const conn = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  properties: { baseUrl: base },
  authType: "none",
  secret: null,
  ...over,
});

describe("parseOperation", () => {
  it("parses method and path", () => {
    expect(parseOperation("post /orders")).toEqual({ method: "POST", path: "/orders" });
    expect(() => parseOperation("FETCH /x")).toThrow(/look like/);
    expect(() => parseOperation("GET orders")).toThrow(AdapterError);
  });
});

describe("rest.invoke", () => {
  it("sends JSON bodies with default and per-request headers, and parses JSON", async () => {
    const res = (await rest.invoke(conn({ properties: { baseUrl: base, headers: { "X-Tenant": "eu" } } }), {
      operation: "POST /orders",
      config: {},
      request: { body: { total: 12.5 }, headers: { "X-Trace": "t1" } },
    })) as any;
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 7, got: { total: 12.5 } });
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.headers["x-tenant"]).toBe("eu");
    expect(seen[0]?.headers["x-trace"]).toBe("t1");
  });

  it("treats a plain object as the body", async () => {
    const res = (await rest.invoke(conn(), { operation: "POST /orders", config: {}, request: { total: 3 } })) as any;
    expect(res.body.got).toEqual({ total: 3 });
  });

  it("fills path params and query strings", async () => {
    const res = (await rest.invoke(conn(), {
      operation: "GET /orders/{id}",
      config: {},
      request: { params: { id: "a b" }, query: { tag: ["x", "y"], skip: null } },
    })) as any;
    expect(seen[0]?.url).toBe("/orders/a%20b?tag=x&tag=y");
    expect(res.body.id).toBe("a%20b");
  });

  it("explains a missing path param", async () => {
    await expect(rest.invoke(conn(), { operation: "GET /orders/{id}", config: {}, request: {} })).rejects.toThrow(
      /needs "id"/,
    );
  });

  it("fails non-2xx with a code, the body, and retryability", async () => {
    const e422 = await rest
      .invoke(conn(), { operation: "POST /bad", config: {}, request: {} })
      .then(unexpected, asAdapterError);
    expect(e422).toBeInstanceOf(AdapterError);
    expect(e422.code).toBe("http_422");
    expect(e422.message).toContain("total must be positive");
    expect(e422.retryable).toBe(false);
    const e503 = await rest
      .invoke(conn(), { operation: "GET /boom", config: {}, request: null })
      .then(unexpected, asAdapterError);
    expect(e503.code).toBe("http_503");
    expect(e503.retryable).toBe(true);
  });

  it("returns text bodies as strings", async () => {
    const res = (await rest.invoke(conn(), { operation: "GET /text", config: {}, request: null })) as any;
    expect(res.body).toBe("hello");
  });

  it("times out", async () => {
    const e = await rest
      .invoke(conn({ properties: { baseUrl: base, timeoutSeconds: 1 } }), {
        operation: "GET /slow",
        config: {},
        request: null,
      })
      .then(unexpected, asAdapterError);
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(true);
  });

  it("adds auth headers", async () => {
    await rest.invoke(conn({ authType: "bearer", secret: { token: "tok" } }), {
      operation: "GET /text",
      config: {},
      request: null,
    });
    expect(seen[0]?.headers.authorization).toBe("Bearer tok");
    await rest.invoke(
      conn({ authType: "api_key", secret: { apiKey: "k1" }, properties: { baseUrl: base, apiKeyHeader: "X-Key" } }),
      { operation: "GET /text", config: {}, request: null },
    );
    expect(seen[1]?.headers["x-key"]).toBe("k1");
  });
});

describe("rest.test", () => {
  it("passes with good credentials and explains bad ones", async () => {
    const good = await rest.test(
      conn({
        authType: "basic",
        secret: { username: "ada", password: "secret" },
        properties: { baseUrl: base, testPath: "/me" },
      }),
    );
    expect(good).toMatchObject({ ok: true });
    const bad = await rest.test(
      conn({
        authType: "basic",
        secret: { username: "ada", password: "nope" },
        properties: { baseUrl: base, testPath: "/me" },
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("rejected the credentials");
  });

  it("explains an invalid base URL", async () => {
    const r = await rest.test(conn({ properties: { baseUrl: "not a url" } }));
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain("full URL");
  });
});

describe("private network guard", () => {
  it("knows private ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fd00::1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("blocks local targets unless allowed", async () => {
    process.env.ALLOW_PRIVATE_NETWORK = "false";
    const e = await rest
      .invoke(conn(), { operation: "GET /text", config: {}, request: null })
      .then(unexpected, asAdapterError);
    expect(e.code).toBe("private_network");
    const e2 = await rest
      .invoke(conn({ properties: { baseUrl: base.replace("127.0.0.1", "localhost") } }), {
        operation: "GET /text",
        config: {},
        request: null,
      })
      .then(unexpected, asAdapterError);
    expect(e2.code).toBe("private_network");
  });
});
