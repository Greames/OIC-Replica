import { expect, type Page, test } from "@playwright/test";
import { signUpWithWorkspace } from "./helpers";

const mock = `http://127.0.0.1:${process.env.MOCK_API_PORT ?? 4010}`;

async function setUp(page: Page) {
  await signUpWithWorkspace(page, "p3");
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

test("build an integration on the canvas, fix a problem, run it and see the run on the canvas", async ({ page }) => {
  await setUp(page);
  await page.getByRole("link", { name: "Integrations" }).click();
  await page.getByLabel("New integration").fill("Orders log");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Orders log", exact: true })).toBeVisible();

  const canvas = page.getByRole("figure", { name: "Integration canvas" });
  const settings = page.getByRole("region", { name: "Step settings" });
  await expect(canvas).toBeVisible();

  // 1. Call the API
  await canvas.getByRole("button", { name: /Add a step here \(top level steps 0\)/ }).click();
  await page.getByRole("dialog", { name: "Add a step" }).getByRole("button", { name: "Call a connection" }).click();
  await settings.getByLabel("Label").fill("Read orders");
  await settings.getByLabel("Connection").selectOption("mock_api");
  await settings.getByLabel("Operation").fill("GET /orders");
  await expect(page.getByText("No problems")).toBeVisible();

  // 2. Loop over the orders
  await canvas.getByRole("button", { name: /Insert a step \(top level steps 1\)/ }).click();
  await page.getByRole("dialog", { name: "Add a step" }).getByRole("button", { name: "For each" }).click();
  await settings.getByLabel("Over (JSONata list)").fill("$invoke.body.orders");
  await settings.getByLabel("Name each item").fill("order");
  // An empty loop is a problem, shown on the step
  await expect(page.getByRole("status").filter({ hasText: "1 problem(s)" })).toBeVisible();
  await expect(settings.getByRole("list", { name: "Problems with this step" })).toContainText(
    "Add at least one step here.",
  );
  await expect(canvas.locator('[data-step-id="each"]')).toContainText("1");

  // 3. Log each order inside the loop
  await canvas.getByRole("button", { name: /Add a step here \(each steps 0\)/ }).click();
  await page.getByRole("dialog", { name: "Add a step" }).getByRole("button", { name: "Log" }).click();
  await settings.getByLabel("Message").fill("order {{ $order.id + }}");
  await expect(settings.getByText(/Expected|Syntax|unexpected/i).first()).toBeVisible(); // live parse error
  await settings.getByLabel("Message").fill("order {{ $order.id }} total {{ $order.total }}");
  await expect(page.getByText("No problems")).toBeVisible();

  // Undo removes the last change; a reference to a step that runs later is flagged
  await settings.getByLabel("Message").fill("{{ $later.id }}");
  await expect(page.getByRole("status").filter({ hasText: "problem(s)" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("No problems")).toBeVisible();

  // Move the log out of the loop and back with Undo; delete and undo
  await settings.getByRole("button", { name: "Delete step" }).click();
  await expect(canvas.locator('[data-step-id="log"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(canvas.locator('[data-step-id="log"]')).toHaveCount(1);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. Ready to activate.")).toBeVisible();

  // The JSON view shows the same document
  await page.getByRole("link", { name: "JSON" }).click();
  await expect(page.getByLabel("Integration definition (JSON)")).toHaveValue(/"type": "forEach"/);
  await page.getByRole("link", { name: "Canvas" }).click();

  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Schedule saved.")).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(canvas.getByRole("button", { name: /Insert a step/ })).toHaveCount(0); // read-only while active

  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/observability\/runs\//);
  await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const replay = page.getByRole("figure", { name: "Run on the integration" });
  await expect(replay.locator('[data-step-id="invoke"]')).toHaveAttribute("data-status", "succeeded");
  await expect(replay.locator('[data-step-id="log"]')).toContainText("×2");
  await replay.locator('[data-step-id="invoke"]').click();
  await expect(page.locator('details[data-step="invoke"]')).toHaveAttribute("open", "");
});

test("an AI proposal can be reviewed on the canvas", async ({ page }) => {
  await signUpWithWorkspace(page, "p3ai");
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByLabel("New project").fill("Support");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByLabel("Describe the integration you want").fill("Route tickets by priority");
  await page.getByRole("button", { name: "Build it" }).click();
  const proposal = page.getByRole("region", { name: "Proposal: Ticket router" });
  await expect(proposal).toBeVisible({ timeout: 15_000 });
  await proposal.getByRole("button", { name: "Show on canvas" }).click();
  const canvas = page.getByRole("figure", { name: "Proposed integration: Ticket router" });
  await expect(canvas.locator('[data-step-id="route"]')).toBeVisible();
  await expect(canvas).toContainText("High");
  await expect(canvas).toContainText("Otherwise");
  await expect(canvas).toContainText("When called: POST /");
});
