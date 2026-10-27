import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client.js";
import { orgs } from "./schema/auth.js";
import { secretStore } from "./secret-store.js";
import { asSystem } from "./tenancy.js";

/**
 * Removes a tenant: first its credentials from the secret store, then the
 * organization row, which cascades to every tenant table. Credentials go
 * first so a failure never leaves secrets behind for a tenant that is gone.
 */
export async function offboardTenant(db: Db, orgId: string): Promise<{ secrets: number; deleted: boolean }> {
  const secrets = await secretStore(db).deleteTenant(orgId);
  const rows = await asSystem(db, "offboardTenant", (tx) =>
    tx.delete(orgs).where(eq(orgs.id, orgId)).returning({ id: orgs.id }),
  );
  return { secrets, deleted: rows.length > 0 };
}

// node packages/db/dist/offboard.js <org id>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const orgId = process.argv[2];
  if (!orgId) {
    console.error("usage: offboard <org id>");
    process.exit(2);
  }
  const db = createDb();
  offboardTenant(db, orgId).then(
    async (r) => {
      console.log(`removed ${r.secrets} secret(s); organization ${r.deleted ? "deleted" : "not found"}`);
      await db.$client.end();
    },
    async (e) => {
      console.error(e);
      await db.$client.end();
      process.exit(1);
    },
  );
}
