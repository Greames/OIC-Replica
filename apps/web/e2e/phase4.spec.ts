import { createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, type Page, test } from "@playwright/test";
import { signUpWithWorkspace } from "./helpers";

const mock = `http://127.0.0.1:${process.env.MOCK_API_PORT ?? 4010}`;

interface Hook {
  path: string;
  headers: Record<string, string>;
  body: string;
}

async function hooksFor(page: Page, path: string): Promise<Hook[]> {
  const all = (await (await page.request.get(`${mock}/_hooks`)).json()) as Hook[];
  return all.filter((h) => h.path === path);
}

async function createKey(page: Page, name: string, scopes: ("build" | "operate")[]): Promise<string> {
  await page.goto("/settings/api-keys");
  await page.getByLabel("Name").fill(name);
  for (const s of scopes) await page.getByRole("checkbox", { name: new RegExp(s, "i") }).check();
  await page.getByRole("button", { name: "Create key" }).click();
  const key = (await page.getByTestId("new-api-key").textContent())?.trim() ?? "";
  expect(key).toMatch(/^oicr_[0-9a-f]{8}_/);
  return key;
}

test("every update: live activity, a signed webhook (Hermes), the API and the MCP server", async ({
  page,
  browser,
  baseURL,
}) => {
  await signUpWithWorkspace(page, "p4");
  const hookPath = `/hooks/hermes-${Date.now()}`;

  // A webhook channel, the way Hermes Agent's webhook route receives updates.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Notifications" }).click();
  await page.getByLabel("Send to").selectOption("webhook");
  await page.getByLabel("Name").fill("Hermes Agent");
  await page.getByLabel("URL").fill(`${mock}${hookPath}`);
  const secret = await page.getByLabel("Signing secret").inputValue();
  expect(secret.length).toBeGreaterThanOrEqual(16);
  await page.getByRole("button", { name: "Add channel" }).click();
  const channels = page.getByRole("list", { name: "Channels" });
  await expect(channels).toContainText("Hermes Agent");
  await expect(channels).toContainText("127.0.0.1:4010");

  await channels.getByRole("button", { name: "Send test" }).click();
  await expect(channels.getByRole("status")).toContainText("Sent");
  await expect.poll(async () => (await hooksFor(page, hookPath)).length).toBe(1);

  // Activity updates live while something happens in another tab.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Activity" }).click();
  await expect(page.locator("[data-live-connected=yes]")).toBeAttached();
  const other = await page.context().newPage();
  await other.goto("/connections/new");
  await other.getByLabel("Name *").fill("Mock API");
  await other.getByLabel("Identifier").fill("mock_api");
  await other.getByLabel("Base URL *").fill(mock);
  await other.getByLabel("Test path").fill("/health");
  await other.getByLabel("Authentication").selectOption("api_key");
  await other.getByLabel("API key *").fill("k-123");
  await other.getByRole("button", { name: "Create connection" }).click();
  await other.getByRole("button", { name: "Test connection" }).click();
  await expect(other.getByText("ready", { exact: true })).toBeVisible();
  await other.close();

  const feed = page.getByRole("region", { name: "Activity feed" }).or(page.getByLabel("Activity feed"));
  await expect(feed.locator('[data-event-type="connection.test_passed"]')).toContainText("Mock API");

  // The worker delivers the same update to the webhook, signed like Hermes expects.
  await expect
    .poll(
      async () => (await hooksFor(page, hookPath)).some((h) => h.headers["x-oicr-event"] === "connection.test_passed"),
      { timeout: 20_000 },
    )
    .toBe(true);
  const hook = (await hooksFor(page, hookPath)).find((h) => h.headers["x-oicr-event"] === "connection.test_passed")!;
  const ts = hook.headers["x-webhook-timestamp"]!;
  expect(hook.headers["x-webhook-signature-v2"]).toBe(
    createHmac("sha256", secret).update(`${ts}.${hook.body}`).digest("hex"),
  );
  const payload = JSON.parse(hook.body);
  expect(payload).toMatchObject({ event_type: "connection.test_passed", severity: "info" });
  expect(payload.text).toContain("Mock API");
  expect(payload.url).toContain(baseURL);

  // API keys: shown once, read-only unless given more.
  const readKey = await createKey(page, "Read only", []);
  await expect(page.getByLabel("API keys")).toContainText("Read only");
  const api = (path: string, key: string, init: { method?: string } = {}) =>
    page.request.fetch(`${baseURL}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${key}` },
    });

  expect((await page.request.get(`${baseURL}/api/v1/events`)).status()).toBe(401);
  const events = await (await api("/api/v1/events?since_id=0", readKey)).json();
  expect(events.events.map((e: { type: string }) => e.type)).toContain("connection.test_passed");
  expect(events.next_since_id).toBeGreaterThan(0);
  const none = await (await api(`/api/v1/events?since_id=${events.next_since_id}`, readKey)).json();
  expect(none.events).toEqual([]);

  // MCP: what Hermes Agent connects to.
  const mcp = async (key: string) => {
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  };
  const reader = await mcp(readKey);
  const readTools = (await reader.listTools()).tools.map((t) => t.name);
  expect(readTools).toEqual(expect.arrayContaining(["list_integrations", "get_run", "list_events", "list_lookups"]));
  expect(readTools).not.toContain("run_integration");
  expect((await reader.listTools()).tools.find((t) => t.name === "list_events")?.annotations?.readOnlyHint).toBe(true);
  const listed = await reader.callTool({
    name: "list_events",
    arguments: { since_id: 0, types: ["connection.test_passed"] },
  });
  const text = (listed.content as { type: string; text: string }[])[0]!.text;
  expect(JSON.parse(text).events[0].summary).toContain("Mock API");
  const integrations = await reader.callTool({ name: "list_integrations", arguments: {} });
  expect(JSON.parse((integrations.content as { text: string }[])[0]!.text)).toEqual([]);
  await reader.close();

  const operator = await mcp(await createKey(page, "Hermes Agent", ["operate"]));
  expect((await operator.listTools()).tools.map((t) => t.name)).toContain("run_integration");
  const missing = await operator.callTool({
    name: "get_run",
    arguments: { run_id: "00000000-0000-4000-8000-000000000000" },
  });
  expect(missing.isError).toBe(true);
  await operator.close();

  // A bad key gets nothing.
  expect((await api("/api/v1/integrations", "oicr_00000000_nope")).status()).toBe(401);
  void browser;
});
