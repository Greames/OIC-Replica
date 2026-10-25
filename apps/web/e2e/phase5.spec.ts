import { expect, type Page, test } from "@playwright/test";
import { signUpWithWorkspace } from "./helpers";

const mock = `http://127.0.0.1:${process.env.MOCK_API_PORT ?? 4010}`;

async function setUp(page: Page) {
  await signUpWithWorkspace(page, "p5");
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

test("a lookup from CSV, a visual mapping with a list, a function and the lookup, tested and run", async ({ page }) => {
  await setUp(page);

  // Lookup: import CSV, a duplicate key is refused
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Lookups" }).click();
  await page.getByRole("link", { name: "New lookup" }).click();
  await page.getByLabel("Name", { exact: true }).fill("codes");
  await page.getByRole("button", { name: "Import CSV" }).click();
  await page.getByLabel("Or paste CSV").fill("shop,erp\nA1,ERP-ONE\nA2,ERP-TWO\nA1,again");
  await page.getByRole("button", { name: "Import pasted CSV" }).click();
  await expect(page.getByLabel("Domain 2")).toHaveValue("erp");
  await page.getByRole("button", { name: "Create lookup" }).click();
  await expect(page.getByLabel("Problems")).toContainText('"A1" is in shop twice (rows 1 and 3).');
  await page.getByRole("button", { name: "Remove row 3" }).click();
  await page.getByRole("button", { name: "Create lookup" }).click();
  await expect(page).toHaveURL(/\/lookups\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Row 2 erp")).toHaveValue("ERP-TWO");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Lookups" }).click();
  await expect(page.getByRole("link", { name: "codes" })).toBeVisible();

  // Integration: call the API, then map its orders
  await page.getByRole("link", { name: "Integrations" }).click();
  await page.getByLabel("New integration").fill("Orders to ERP");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const canvas = page.getByRole("figure", { name: "Integration canvas" });
  const settings = page.getByRole("region", { name: "Step settings" });
  await canvas.getByRole("button", { name: /Add a step here \(top level steps 0\)/ }).click();
  await page.getByRole("dialog", { name: "Add a step" }).getByRole("button", { name: "Call a connection" }).click();
  await settings.getByLabel("Connection").selectOption("mock_api");
  await settings.getByLabel("Operation").fill("GET /orders");
  await canvas.getByRole("button", { name: /Insert a step \(top level steps 1\)/ }).click();
  await page.getByRole("dialog", { name: "Add a step" }).getByRole("button", { name: "Map data" }).click();
  await settings.getByRole("button", { name: "Open mapper" }).click();

  const mapper = page.getByRole("dialog", { name: "Mapper" });
  const sources = mapper.getByRole("region", { name: "Sources" });
  const target = mapper.getByRole("region", { name: "Target" });
  // No run yet: paste a sample of the API's answer
  await sources.getByRole("button", { name: "Paste a sample" }).first().click();
  await sources
    .getByLabel("Sample for invoke")
    .fill('{ "status": 200, "body": { "orders": [ { "id": "A1", "total": 10 } ] } }');
  await sources.getByRole("button", { name: "Use sample" }).click();
  await expect(sources.locator('[data-path="$invoke.body.orders.total"]')).toBeVisible();

  // A list of orders: items are mapped relative to each order
  await target.getByRole("button", { name: "List" }).click();
  await target.getByLabel("Name of target items").fill("orders");
  await sources.locator('[data-path="$invoke.body.orders"]').click();
  await expect(target.getByLabel("List source of orders")).toHaveValue("$invoke.body.orders");
  await sources.locator('[data-path="$invoke.body.orders.id"]').click();
  await expect(target.getByLabel("Expression of id")).toHaveValue("id");
  await target.getByLabel("Name of target orders").click();
  await sources.locator('[data-path="$invoke.body.orders.total"]').click();
  await expect(target.getByLabel("Expression of total")).toHaveValue("total");
  // Functions apply to the selected field
  await mapper.getByRole("button", { name: "× 100", exact: true }).click();
  await expect(target.getByLabel("Expression of total")).toHaveValue("$round(total * 100)");
  await target.getByLabel("Expression of id").click();
  await mapper.getByRole("button", { name: "codes", exact: true }).click();
  await expect(target.getByLabel("Expression of id")).toHaveValue('$lookupValue("codes", "shop", id, "erp")');
  await target.getByLabel("Name of target id").fill("erp_code");
  // A field typed by hand
  await target.getByRole("button", { name: "Field", exact: true }).click();
  await target.getByLabel("Name of target field").fill("count");
  await target.getByLabel("Expression of count").fill("$count($invoke.body.orders)");

  await mapper.getByRole("button", { name: "Run test" }).click();
  await expect(mapper.getByLabel("Test result")).toContainText('"erp_code": "ERP-ONE"');
  await expect(mapper.getByLabel("Test result")).toContainText('"total": 1000');
  await mapper.getByRole("tab", { name: "Code" }).click();
  await expect(mapper.getByLabel("Mapping code")).toHaveValue(/"orders": \[\$invoke\.body\.orders\.\{/);
  await mapper.getByRole("tab", { name: "Fields" }).click();
  await expect(target.getByLabel("Expression of count")).toHaveValue("$count($invoke.body.orders)");
  await mapper.getByRole("button", { name: "Done" }).click();

  await expect(settings.getByLabel("Expression (JSONata)")).toHaveValue(/\$lookupValue\("codes"/);
  await expect(page.getByText("No problems")).toBeVisible();
  // A lookup that does not exist is flagged
  await settings.getByLabel("Expression (JSONata)").fill('{ "x": $lookupValue("nope", "a", 1, "b") }');
  await expect(settings.getByRole("list", { name: "Problems with this step" })).toContainText(
    'Lookup "nope" does not exist',
  );
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. Ready to activate.")).toBeVisible();

  // Run it: the lookup translates the codes
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Schedule saved.")).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/observability\/runs\//);
  await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const mapRecord = page.locator('details[data-step="map"]');
  await mapRecord.locator("summary").click();
  await expect(mapRecord).toContainText("ERP-TWO");
  await expect(mapRecord).toContainText("-100");

  // The mapper is still there, read-only, with the run's data as samples
  await page.goBack();
  await canvas.locator('[data-step-id="map"]').click();
  await settings.getByRole("button", { name: "Open mapper" }).click();
  await expect(mapper.getByLabel("List source of orders")).toBeDisabled();
  await expect(sources.locator('[data-path="$invoke.body.orders.total"]')).toBeVisible();
});
