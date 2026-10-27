import { expect, test } from "@playwright/test";
import { signUpWithWorkspace } from "./helpers";

// P3: the semantic catalog. Bind a system with AI (scripted) and review it,
// translate through the catalog in an integration, and see when bindings
// changed after activation.
test("bind a system with AI, translate through the catalog, and see binding drift", async ({ page }) => {
  await signUpWithWorkspace(page, "p6");
  await page.getByRole("link", { name: "Semantic catalog" }).click();
  await expect(page.getByRole("heading", { name: "Semantic catalog" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Oracle E-Business Suite" })).toBeVisible();
  await page.getByRole("link", { name: "HZ_CUST_ACCOUNTS" }).click();
  await expect(page.getByRole("cell", { name: "ACCOUNT_NUMBER", exact: true })).toBeVisible();
  await expect(page.getByText('$toSemantic($source, "oracle-ebs", "HZ_CUST_ACCOUNTS")')).toBeVisible();

  // The AI reads a sample of a system the platform does not know.
  await page.goto("/catalog/discover");
  await page.getByLabel("System").fill("legacy-crm");
  await page.getByLabel("Object").fill("CUSTOMERS");
  await page
    .getByLabel("Sample", { exact: true })
    .fill(JSON.stringify([{ CUST_NO: "C-1", CUST_NAME: "Acme", STAT: "A", ZIP: "10115" }]));
  await page.getByRole("button", { name: "Propose bindings with AI" }).click();
  await expect(page).toHaveURL(/\/catalog\/systems\/legacy-crm\/CUSTOMERS$/);
  await expect(page.getByText("AI proposal: CUSTOMERS holds Customer records")).toBeVisible();
  // Confident bindings applied; the uncertain one waits for a person.
  await expect(page.getByText(/1 of 3 to review/)).toBeVisible();
  await page.getByRole("button", { name: "Approve STAT" }).click();
  // The last decision closes the proposal; it moves to the history below.
  await expect(page.getByText("AI proposal: CUSTOMERS holds Customer records")).toBeHidden();
  await expect(page.getByText("Earlier AI proposals")).toBeVisible();
  await expect(page.getByText("AI · 70%")).toBeVisible();
  await expect(page.getByText('read: $value = "A"')).toBeVisible();

  // An integration translates legacy CRM customers into NetSuite customers.
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByLabel("New project").fill("CRM");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByLabel("New integration").fill("Customers to NetSuite");
  await page.getByLabel("Starts").selectOption("application");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Customers to NetSuite" })).toBeVisible();
  const integrationUrl = page.url();
  await page.getByRole("link", { name: "JSON" }).click();
  await page.getByLabel("Integration definition (JSON)").fill(
    JSON.stringify({
      schemaVersion: 1,
      style: "application",
      trigger: { id: "t", type: "http", method: "POST", sync: true },
      steps: [
        {
          id: "r",
          type: "return",
          body: '$translate($trigger, "legacy-crm", "CUSTOMERS", "netsuite", "customer")',
        },
      ],
    }),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. Ready to activate.")).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await page.getByLabel("Test request body (JSON)").fill('{ "CUST_NO": "C-9", "CUST_NAME": "Initech", "STAT": "I" }');
  await page.getByRole("button", { name: "Send test request" }).click();
  const response = page.locator("pre").filter({ hasText: '"entityId": "C-9"' }).first();
  await expect(response).toBeVisible();
  await expect(response).toContainText('"companyName": "Initech"');
  await expect(response).toContainText('"isInactive": true');

  // A binding changes after activation: runs keep the pinned plan, and the page says so.
  await page.goto("/catalog/systems/netsuite/customer");
  await page.getByRole("button", { name: "Unbind phone" }).click();
  await expect(page.getByText("phone is unbound.")).toBeVisible();
  await expect(page.getByText("Platform bindings switched off:")).toBeVisible();
  await page.goto(integrationUrl);
  await expect(page.getByText(/netsuite \/ customer changed since this integration was activated/)).toBeVisible();
});
