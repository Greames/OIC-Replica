import { expect, test } from "@playwright/test";

// Phase 0 vertical slice: sign up → workspace → project → settings → sign out.
test("a new user signs up, creates a workspace and a project", async ({ page }, info) => {
  const email = `e2e-${info.project.name}-${Date.now()}@example.com`;

  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole("link", { name: "Create an account" }).click();

  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("analytical-engine");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByLabel("Workspace name")).toHaveValue("Ada's team");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page.getByRole("heading", { name: "Hi, Ada" })).toBeVisible();
  await expect(page.getByText("No projects yet.")).toBeVisible();

  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByLabel("New project").fill("Orders sync (EU)");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Orders sync (EU)" })).toBeVisible();
  await expect(page.getByText("ORDERS_SYNC_EU")).toBeVisible();

  // Same identifier again is refused with a readable message.
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByLabel("New project").fill("Orders sync EU");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already exists" }).first()).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  const main = page.getByRole("main");
  await expect(main.getByText(email)).toBeVisible();
  await expect(main.getByText("admin", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  await page.getByLabel("Password").fill("analytical-engine");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Hi, Ada" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Orders sync (EU)" })).toBeVisible();
});
