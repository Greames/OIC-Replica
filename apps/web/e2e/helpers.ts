import { expect, type Page } from "@playwright/test";

export async function signUpWithWorkspace(page: Page, tag: string): Promise<string> {
  const email = `${tag}-${Date.now()}@example.com`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("analytical-engine");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Hi, Ada" })).toBeVisible();
  return email;
}
