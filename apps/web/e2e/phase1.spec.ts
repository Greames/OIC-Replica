import { expect, test } from "@playwright/test";
import { signUpWithWorkspace } from "./helpers";

const mock = `http://127.0.0.1:${process.env.MOCK_API_PORT ?? 4010}`;

const ordersFlow = {
  schemaVersion: 1,
  style: "scheduled",
  trigger: { id: "trigger", type: "schedule" },
  steps: [
    { id: "get", type: "invoke", connection: "mock_api", operation: "GET /orders" },
    {
      id: "each",
      type: "forEach",
      over: "$get.body.orders",
      as: "order",
      steps: [
        {
          id: "guard",
          type: "scope",
          steps: [
            {
              id: "post",
              type: "invoke",
              connection: "mock_api",
              operation: "POST /shop/orders",
              request: '{ "body": { "external_id": $order.id, "total_cents": $order.total * 100 } }',
            },
          ],
          onFault: [{ id: "note", type: "log", message: "order {{$order.id}} failed: {{$fault.code}}" }],
        },
      ],
    },
  ],
  businessIds: [{ name: "first", expr: "$get.body.orders[0].id", primary: true }],
};

test("connect an API, build a scheduled integration, run it and inspect every step", async ({ page }) => {
  await signUpWithWorkspace(page, "p1");

  // Project
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByLabel("New project").fill("Commerce");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Commerce" })).toBeVisible();

  // Connection: wrong key first, then fix it
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("link", { name: "New connection" }).click();
  await page.getByLabel("Name *").fill("Mock API");
  await page.getByLabel("Identifier").fill("mock_api");
  await page.getByLabel("Base URL *").fill(mock);
  await page.getByLabel("Test path").fill("/health");
  await page.getByLabel("Authentication").selectOption("api_key");
  await page.getByLabel("API key *").fill("wrong");
  await page.getByRole("button", { name: "Create connection" }).click();
  await expect(page.getByText("Saved. Test it to make sure it works.")).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "rejected the credentials" })).toBeVisible();

  await expect(page.getByLabel("API key *")).toHaveAttribute("placeholder", /Stored/);
  await page.getByLabel("API key *").fill("k-123");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changed since the last test. Test it again.")).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/^Last tested /)).toBeVisible();
  await expect(page.getByText("ready", { exact: true })).toBeVisible();

  // Integration
  await page.getByRole("link", { name: "Integrations" }).click();
  await page.getByLabel("New integration").fill("Orders to shop");
  await page.getByLabel("Starts").selectOption("scheduled");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Orders to shop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate" })).toBeDisabled();

  const editor = page.getByLabel("Integration definition (JSON)");
  // A typo in the connection is caught with a readable message.
  await editor.fill(
    JSON.stringify(
      { ...ordersFlow, steps: [{ ...ordersFlow.steps[0], connection: "mock_apii" }, ordersFlow.steps[1]] },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("list", { name: "Problems" })).toContainText('Connection "mock_apii" does not exist');

  await editor.fill(JSON.stringify(ordersFlow, null, 2));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. Ready to activate.")).toBeVisible();

  await page.getByLabel("Interval").fill("PT15M");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Schedule saved.")).toBeVisible();

  await page.getByLabel("Payload tracing").selectOption("debug");
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("active", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/next run/)).toBeVisible();

  // Run now → the worker picks it up
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/observability\/runs\//);
  await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const activity = page.locator("ol");
  await expect(activity.locator("li")).toHaveCount(7);
  await expect(activity).toContainText("order A2 failed: http_422");
  await expect(page.getByText("A1", { exact: true })).toBeVisible();

  // The failed step opens by default and shows why
  await expect(page.locator("details[open]")).toContainText("negative total");

  const received = await (await page.request.get(`${mock}/_received`)).json();
  expect(received).toEqual(expect.arrayContaining([{ external_id: "A1", total_cents: 1000 }]));

  // Find it by business ID
  await page.getByRole("link", { name: "Observability" }).click();
  await page.getByLabel("Business ID").fill("A1");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("cell", { name: "A1" })).toBeVisible();
});

test("build an HTTP integration from a template, test it, and call it with its token", async ({ page }) => {
  await signUpWithWorkspace(page, "p1http");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByLabel("New project").fill("Edge");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Edge" })).toBeVisible();

  await page.getByLabel("New integration").fill("Echo");
  await page.getByLabel("Starts").selectOption("application");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Echo" })).toBeVisible();

  await page.getByLabel("Start from a template").selectOption({ label: "Echo (no connections needed)" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. Ready to activate.")).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();

  await page.getByLabel("Test request body (JSON)").fill('{ "hello": "world" }');
  await page.getByRole("button", { name: "Send test request" }).click();
  await expect(page.locator("pre").filter({ hasText: '"hello": "world"' }).first()).toBeVisible();

  await page.getByRole("button", { name: "Show token" }).click();
  const curl = page.locator("pre").filter({ hasText: "curl -X POST" });
  await expect(curl).toContainText("oicr_t_");
  const text = (await curl.textContent()) ?? "";
  const url = text.match(/'(http[^']+)'/)?.[1] ?? "";
  const token = text.match(/Bearer (oicr_t_[\w-]+)/)?.[1] ?? "";

  const ok = await page.request.post(url, {
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "x1" },
    data: { n: 1 },
  });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).received).toEqual({ n: 1 });
  const again = await page.request.post(url, {
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "x1" },
    data: { n: 1 },
  });
  expect((await again.json()).duplicate).toBe(true);

  expect((await page.request.post(url, { data: {} })).status()).toBe(401);
  expect((await page.request.get(url, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(405);
});
