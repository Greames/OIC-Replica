import { expect, type Page, test } from "@playwright/test";
import { signUpWithWorkspace } from "./helpers";

// Runs against the scripted model (AI_PROVIDER=scripted): the UI, the loop,
// tools, validation, persistence and accept are real; only Claude's turns are recorded.

const mock = `http://127.0.0.1:${process.env.MOCK_API_PORT ?? 4010}`;

async function setUp(page: Page) {
  await signUpWithWorkspace(page, "p2");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByLabel("New project").fill("Commerce");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Commerce" })).toBeVisible();

  await page.goto("/connections/new");
  await page.getByLabel("Name *").fill("Mock API");
  await page.getByLabel("Identifier").fill("mock_api");
  await page.getByLabel("Base URL *").fill(mock);
  await page.getByLabel("Test path").fill("/health");
  await page.getByLabel("Authentication").selectOption("api_key");
  await page.getByLabel("API key *").fill("k-123");
  await page.getByRole("button", { name: "Create connection" }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("ready", { exact: true })).toBeVisible();
}

test("describe an integration in English, answer a question, accept, run, then change it by instruction", async ({
  page,
}) => {
  await setUp(page);

  await page.getByRole("link", { name: "Home" }).click();
  await page.getByLabel("Describe the integration you want").fill("Send new orders from the mock API to the shop");
  await page.getByRole("button", { name: "Build it" }).click();

  const convo = page.getByRole("list", { name: "Conversation" });
  await expect(convo).toContainText("Send new orders from the mock API to the shop");
  await expect(convo).toContainText("Checked your connections");
  await expect(convo).toContainText("How often should it run?");

  await page.getByRole("button", { name: "Every 15 minutes" }).click();
  const proposal = page.getByRole("region", { name: "Proposal: Orders to shop" });
  await expect(proposal).toBeVisible({ timeout: 15_000 });
  await expect(proposal).toContainText("Every 15 minutes, reads new orders");
  await expect(proposal).toContainText("Create shop order");
  await expect(proposal).toContainText("every 15 minutes");
  await expect(convo).toContainText("you can create it and activate it straight away");

  // The conversation survives a reload.
  await page.reload();
  await expect(page.getByRole("region", { name: "Proposal: Orders to shop" })).toBeVisible();

  await page.getByRole("button", { name: "Create integration" }).click();
  await expect(page.getByRole("heading", { name: "Orders to shop", exact: true })).toBeVisible();
  await expect(page.getByText("Built by the AI builder.")).toBeVisible();
  await expect(page.getByText("every 15 minutes")).toBeVisible();

  await page.getByRole("button", { name: "Activate" }).click();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/observability\/runs\//);
  await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("ol")).toContainText("Order A2 failed: http_422");

  // Change it by instruction
  await page.getByRole("link", { name: "Orders to shop" }).click();
  await page.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.getByRole("button", { name: "Activate" })).toBeVisible();
  await page.getByRole("button", { name: "Edit with AI" }).click();
  await expect(page.getByRole("heading", { name: "AI builder · Orders to shop" })).toBeVisible();
  await page.getByLabel("Message the AI builder").fill("retry creating the shop order 3 times");
  await page.getByRole("button", { name: "Send" }).click();

  const change = page.getByRole("region", { name: "Proposal: Orders to shop" });
  await expect(change).toContainText("Changes to Orders to shop", { timeout: 15_000 });
  await expect(change.getByText("Changes", { exact: true })).toBeVisible();
  await expect(change).toContainText("send·invoke");
  await expect(change).not.toContainText("Adds");
  await page.getByRole("button", { name: "Apply changes" }).click();

  await expect(page.getByRole("heading", { name: "Orders to shop", exact: true })).toBeVisible();
  await expect(page.getByLabel("Integration definition (JSON)")).toHaveValue(/"attempts": 3/);
  await expect(page.getByText("ready", { exact: true })).toBeVisible();
});
