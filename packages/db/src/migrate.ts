import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";
import { moveLegacySecrets } from "./legacy-secrets.js";
import { secretStore } from "./secret-store.js";

/**
 * Applies pending migrations, then moves any pre-v2 credentials out of the
 * database into the secret store. `pnpm db:migrate`, and on deploy before
 * the app starts.
 */
export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  const db = createDb(url);
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    const r = await moveLegacySecrets(db, secretStore(db));
    if (r.connections + r.channels + r.triggerTokens > 0)
      console.log(
        `moved legacy secrets: ${r.connections} connection(s), ${r.channels} channel(s), ${r.triggerTokens} trigger token(s)`,
      );
    for (const f of r.failed.filter((x) => x.permanent))
      console.warn(
        `left in place (re-enter it in the app, or restore the old SECRETS_KEY and run again): ${f.table} ${f.id}: ${f.error}`,
      );
    const retryable = r.failed.filter((x) => !x.permanent);
    if (retryable.length > 0) {
      for (const f of retryable) console.error(`could not move ${f.table} ${f.id}: ${f.error}`);
      throw new Error(
        `${retryable.length} legacy secret(s) could not be moved; they are kept in place. Fix the cause and run again.`,
      );
    }
  } finally {
    await db.$client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations().then(
    () => console.log("migrations applied"),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
