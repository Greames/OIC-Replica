import { expect, test } from "@playwright/test";
import { signUpWithWorkspace } from "./helpers";

// E2E_SCREENSHOTS=dir saves the key screens for review.
const shot = async (page: import("@playwright/test").Page, name: string) => {
  if (process.env.E2E_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/${name}.png`, fullPage: true });
};

// P4: a database connection and a batch pipeline. The integration creates a
// source table of 3000 rows, then a pipeline loads it into a target in chunks
// on the batch engine; one row is too long for the target and is set aside.
test("load a table with a batch pipeline and see its progress and rejected records", async ({ page }) => {
  await signUpWithWorkspace(page, "p7");
  const db = new URL(process.env.DATABASE_URL ?? "postgres://oicr:oicr@localhost:5432/oicr");
  const suffix = Date.now().toString(36);

  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("link", { name: "New connection" }).click();
  await page.getByRole("link", { name: "Database" }).click();
  await page.getByLabel(/^Name/).fill("Warehouse");
  await page.getByLabel(/^Database \*/).selectOption("postgres");
  await page.getByLabel(/^Host/).fill(db.hostname);
  await page.getByLabel(/^Port/).fill(db.port || "5432");
  await page.getByLabel(/^Database \(service/).fill(db.pathname.slice(1));
  await page.getByLabel(/^TLS/).selectOption("disable");
  await page.getByLabel(/^User/).fill(decodeURIComponent(db.username));
  await page.getByLabel(/^Password/).fill(decodeURIComponent(db.password));
  await page.getByRole("button", { name: "Create connection" }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/Connected to PostgreSQL/)).toBeVisible();
  await shot(page, "p4-connection");

  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByLabel("New project").fill("Data loads");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByLabel("New integration").fill("Customer load");
  await page.getByLabel("Starts").selectOption("application");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Customer load" })).toBeVisible();
  await page.getByRole("link", { name: "JSON" }).click();
  const sql = (s: string) => ({ sql: s });
  await page.getByLabel("Integration definition (JSON)").fill(
    JSON.stringify({
      schemaVersion: 1,
      style: "application",
      trigger: { id: "t", type: "http", method: "POST", sync: false },
      steps: [
        {
          id: "src",
          type: "invoke",
          connection: "warehouse",
          operation: "execute",
          request: JSON.stringify(
            sql(
              `CREATE TABLE e2e_src_${suffix} AS SELECT g AS id, CASE WHEN g = 42 THEN repeat('x', 30) ELSE 'customer ' || g END AS name FROM generate_series(1, 3000) g`,
            ),
          ),
        },
        {
          id: "dst",
          type: "invoke",
          connection: "warehouse",
          operation: "execute",
          request: JSON.stringify(sql(`CREATE TABLE e2e_dst_${suffix} (id INTEGER PRIMARY KEY, name VARCHAR(20))`)),
        },
        {
          id: "load",
          type: "pipeline",
          label: "Load customers",
          source: { connection: "warehouse", operation: "read", config: { table: `e2e_src_${suffix}`, key: "id" } },
          transform: '{ "id": id, "name": $uppercase(name) }',
          target: { connection: "warehouse", operation: "upsert", config: { table: `e2e_dst_${suffix}`, key: "id" } },
          chunkSize: 400,
        },
      ],
    }),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved. Ready to activate.")).toBeVisible();
  await page.getByRole("link", { name: "Canvas" }).click();
  await page.getByText("Load customers").click();
  await expect(page.getByLabel("Transform each record (JSONata, optional)")).toHaveValue(
    '{ "id": id, "name": $uppercase(name) }',
  );
  await shot(page, "p4-inspector");
  await page.getByRole("button", { name: "Activate" }).click();
  await page.getByRole("button", { name: "Create token" }).click();
  const curl = (await page.locator("pre").filter({ hasText: "oicr_t_" }).textContent()) ?? "";
  const url = curl.match(/'(http[^']+)'/)?.[1] ?? "";
  const token = curl.match(/Bearer (oicr_t_[\w-]+)/)?.[1] ?? "";
  const res = await page.request.post(url, { headers: { authorization: `Bearer ${token}` }, data: {} });
  expect(res.status()).toBe(202);
  const { runId } = await res.json();

  await page.goto(`/observability/runs/${runId}`);
  await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const pipelines = page.getByRole("region", { name: "Pipelines" });
  await expect(pipelines.getByRole("row", { name: /load finished 3,000 2,999 0 1 8/ })).toBeVisible();
  await expect(pipelines.getByText("target refused · chunk 1, row 42")).toBeVisible();
  await expect(pipelines.getByText('"id":42')).toBeVisible();
  await shot(page, "p4-run");
});
