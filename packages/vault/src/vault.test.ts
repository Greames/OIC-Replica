import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  cachedStore,
  memoryStore,
  type SecretRef,
  SecretStoreError,
  VaultClient,
  VaultSecretStore,
  vaultOptionsFromEnv,
} from "./index.js";

const ref: SecretRef = { tenant: "11111111-1111-4111-8111-111111111111", kind: "connection", id: "c1" };

describe("references", () => {
  it("refuse anything that could leave the tenant's path", async () => {
    const s = memoryStore();
    for (const bad of ["../x", "a/b", "", "a b", "x".repeat(200)]) {
      await expect(s.put({ ...ref, tenant: bad }, {})).rejects.toBeInstanceOf(SecretStoreError);
      await expect(s.get({ ...ref, id: bad })).rejects.toBeInstanceOf(SecretStoreError);
    }
    await expect(s.put({ ...ref, kind: "other" as never }, {})).rejects.toThrow(/Unknown secret kind/);
  });
});

describe("cache", () => {
  it("serves repeated reads from memory, invalidates on write, expires, and isolates copies", async () => {
    const inner = memoryStore();
    let reads = 0;
    const counting = {
      ...inner,
      get: async (r: SecretRef) => {
        reads++;
        return inner.get(r);
      },
    };
    let clock = 0;
    const s = cachedStore(counting as never, { ttlMs: 1000, now: () => clock });
    await s.put(ref, { apiKey: "k1" });
    const [a, b] = await Promise.all([s.get(ref), s.get(ref)]);
    expect(a).toEqual({ apiKey: "k1" });
    expect(reads).toBe(1);
    (b as Record<string, unknown>).apiKey = "mutated";
    expect(await s.get(ref)).toEqual({ apiKey: "k1" });
    await s.put(ref, { apiKey: "k2" });
    expect(await s.get(ref)).toEqual({ apiKey: "k2" });
    clock += 2000;
    await s.get(ref);
    expect(reads).toBe(3);
    await s.delete(ref);
    expect(await s.get(ref)).toBeNull();
  });
});

// ── against a fake Vault: auth flows, retries, errors ─────────────────────

let server: Server | undefined;
afterEach(() => server?.close());

async function fakeVault(
  handler: (req: { method: string; url: string; token?: string; body: Record<string, unknown> }) => {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  const calls: { method: string; url: string; token?: string }[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const r = {
        method: req.method ?? "",
        url: req.url ?? "",
        token: req.headers["x-vault-token"] as string | undefined,
        body: raw ? JSON.parse(raw) : {},
      };
      calls.push({ method: r.method, url: r.url, token: r.token });
      const out = handler(r);
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { address: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

describe("Vault client", () => {
  it("logs in with AppRole, retries 503s, and re-logs in when the token is revoked", async () => {
    let logins = 0;
    let fails = 1;
    const { address, calls } = await fakeVault((r) => {
      if (r.url === "/v1/auth/approle/login") {
        logins++;
        expect(r.body).toEqual({ role_id: "role", secret_id: "sec" });
        return { status: 200, body: { auth: { client_token: `tok${logins}`, lease_duration: 3600, renewable: true } } };
      }
      if (r.url.startsWith("/v1/oicr/data/")) {
        if (fails-- > 0) return { status: 503, body: { errors: ["sealed"] } };
        if (r.token === "tok1" && logins === 1 && r.method === "GET")
          return { status: 403, body: { errors: ["permission denied"] } };
        return { status: 200, body: { data: { data: { apiKey: "k" }, metadata: { version: 1 } } } };
      }
      return { status: 404 };
    });
    const store = new VaultSecretStore(
      new VaultClient({
        address,
        auth: { method: "approle", roleId: "role", secretId: "sec" },
        retry: { baseDelayMs: 1, maxDelayMs: 2 },
      }),
    );
    expect(await store.get(ref)).toEqual({ apiKey: "k" });
    expect(logins).toBe(2);
    expect(calls.filter((c) => c.url.includes("/data/")).map((c) => c.token)).toEqual(["tok1", "tok1", "tok2"]);
    expect(calls.find((c) => c.url.includes("/data/"))?.url).toBe(`/v1/oicr/data/tenants/${ref.tenant}/connection/c1`);
  });

  it("renews a token when most of its TTL is used, and maps errors without leaking values", async () => {
    let clock = 0;
    let renewals = 0;
    const { address } = await fakeVault((r) => {
      if (r.url === "/v1/auth/token/lookup-self") return { status: 200, body: { data: { ttl: 300, renewable: true } } };
      if (r.url === "/v1/auth/token/renew-self") {
        renewals++;
        return { status: 200, body: { auth: { lease_duration: 300, renewable: true } } };
      }
      if (r.url.includes("/data/") && r.method === "POST") return { status: 200, body: { data: { version: 2 } } };
      if (r.url.includes("/data/")) return { status: 404, body: { errors: [] } };
      if (r.url.includes("/metadata/")) return { status: 403, body: { errors: ["permission denied"] } };
      return { status: 404 };
    });
    const store = new VaultSecretStore(
      new VaultClient({ address, auth: { method: "token", token: "static" }, now: () => clock }),
    );
    await store.put(ref, { password: "hunter2" });
    expect(await store.get(ref)).toBeNull();
    expect(renewals).toBe(0);
    clock += 250_000; // 50 s of 300 s left: renew
    await store.put(ref, { password: "hunter2" });
    expect(renewals).toBe(1);
    const err = await store.delete(ref).catch((e) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect(err.kind).toBe("forbidden");
    expect(String(err.message)).not.toContain("hunter2");
  });

  it("reports an unreachable Vault as unavailable after retrying", async () => {
    const store = new VaultSecretStore(
      new VaultClient({
        address: "http://127.0.0.1:9",
        auth: { method: "token", token: "t" },
        retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      }),
    );
    const err = await store.get(ref).catch((e) => e);
    expect(err).toMatchObject({ name: "SecretStoreError", kind: "unavailable" });
    expect((await store.check()).ok).toBe(false);
  });

  it("reads its settings from the environment", () => {
    expect(vaultOptionsFromEnv({})).toBeNull();
    expect(
      vaultOptionsFromEnv({ VAULT_ADDR: "http://v:8200", VAULT_ROLE_ID: "r", VAULT_SECRET_ID: "s" })?.auth,
    ).toEqual({ method: "approle", roleId: "r", secretId: "s", secretIdFile: undefined, mount: undefined });
    expect(vaultOptionsFromEnv({ VAULT_ADDR: "http://v:8200", VAULT_K8S_ROLE: "oicr" })?.auth.method).toBe(
      "kubernetes",
    );
    expect(vaultOptionsFromEnv({ VAULT_ADDR: "http://v:8200", VAULT_TOKEN_FILE: "/t" })).toMatchObject({
      mount: "oicr",
      auth: { method: "token", tokenFile: "/t" },
    });
  });
});

// ── against a real Vault (VAULT_TEST_ADDR + VAULT_TEST_TOKEN, a dev server) ──

const realAddr = process.env.VAULT_TEST_ADDR;
const rootToken = process.env.VAULT_TEST_TOKEN ?? "root";

describe.skipIf(!realAddr)("real Vault", () => {
  const api = async (method: string, path: string, body?: unknown, token = rootToken) => {
    const res = await fetch(`${realAddr}/v1/${path}`, {
      method,
      headers: { "x-vault-token": token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it("stores per tenant with versions, and a platform policy cannot reach outside its prefix", async () => {
    await api("POST", "sys/mounts/oicr", { type: "kv", options: { version: "2" } });
    await api("PUT", "sys/policies/acl/oicr-platform", {
      policy:
        'path "oicr/data/tenants/*" { capabilities = ["create","update","read"] }\npath "oicr/metadata/tenants/*" { capabilities = ["delete","list"] }',
    });
    await api("POST", "sys/auth/approle", { type: "approle" });
    await api("POST", "auth/approle/role/oicr-platform", { token_policies: ["oicr-platform"], token_ttl: "1h" });
    const roleId = (await api("GET", "auth/approle/role/oicr-platform/role-id")).body.data.role_id;
    const secretId = (await api("POST", "auth/approle/role/oicr-platform/secret-id")).body.data.secret_id;

    const client = new VaultClient({ address: realAddr!, auth: { method: "approle", roleId, secretId } });
    const store = new VaultSecretStore(client);
    expect(await store.check()).toMatchObject({ ok: true });

    const t1: SecretRef = { tenant: "tenant-a", kind: "connection", id: "conn-1" };
    const t2: SecretRef = { tenant: "tenant-b", kind: "connection", id: "conn-1" };
    await store.put(t1, { apiKey: "a-1" });
    await store.put(t1, { apiKey: "a-2" });
    await store.put(t2, { apiKey: "b-1" });
    expect(await store.get(t1)).toEqual({ apiKey: "a-2" });
    expect(await store.get(t2)).toEqual({ apiKey: "b-1" });
    const meta = await api("GET", "oicr/metadata/tenants/tenant-a/connection/conn-1");
    expect(meta.body.data.current_version).toBe(2);

    // The platform token cannot read Vault's own secrets or other mounts.
    const token = await client.token();
    expect((await api("GET", "sys/policies/acl/root", undefined, token)).status).toBe(403);
    expect((await api("GET", "oicr/data/other/x", undefined, token)).status).toBe(403);

    await store.delete(t1);
    expect(await store.get(t1)).toBeNull();
    expect((await api("GET", "oicr/metadata/tenants/tenant-a/connection/conn-1")).status).toBe(404);
    expect(await store.get(t2)).toEqual({ apiKey: "b-1" });

    // Offboarding removes everything under the tenant, and nothing else.
    await store.put({ tenant: "tenant-c", kind: "connection", id: "c1" }, { k: 1 });
    await store.put({ tenant: "tenant-c", kind: "channel", id: "h1" }, { k: 2 });
    await store.put({ tenant: "tenant-c", kind: "connection", id: "c2" }, { k: 3 });
    expect(await store.deleteTenant("tenant-c")).toBe(3);
    expect(await store.get({ tenant: "tenant-c", kind: "channel", id: "h1" })).toBeNull();
    expect(await store.deleteTenant("tenant-c")).toBe(0);
    expect(await store.get(t2)).toEqual({ apiKey: "b-1" });

    // A revoked token is replaced by a fresh login.
    await api("POST", "auth/token/revoke", { token });
    expect(await store.get(t2)).toEqual({ apiKey: "b-1" });
    expect(await client.token()).not.toBe(token);
  });
});
