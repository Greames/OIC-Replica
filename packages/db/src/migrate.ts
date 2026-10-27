import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Db } from "./client.js";
import { moveLegacySecrets } from "./legacy-secrets.js";
import { secretStore } from "./secret-store.js";

/**
 * Applies pending migrations, then moves any pre-v2 credentials out of the
 * database into the secret store. `pnpm db:migrate`, and on deploy before
 * the app starts.
 */
export async function runMigrations(
  url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL,
): Promise<void> {
  const db = createDb(url, { migrations: true });
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
    await enableAppLogin(db);
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

/**
 * Lets the application role log in when APP_DB_PASSWORD is set and this
 * migration user may manage roles (docker compose). Elsewhere a DBA creates
 * the role: NOSUPERUSER NOBYPASSRLS, with DML on the public schema.
 */
async function enableAppLogin(db: Db): Promise<void> {
  const password = process.env.APP_DB_PASSWORD;
  if (!password) return;
  const [me] = await db.execute<{ can: boolean }>(
    sql`select (rolsuper or rolcreaterole) as can from pg_roles where rolname = current_user`,
  );
  const [app] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_roles where rolname = 'oicr_app'`,
  );
  if (!me?.can || !app?.n) {
    console.warn("APP_DB_PASSWORD is set, but the oicr_app role cannot be managed by this user; skipped.");
    return;
  }
  const literal = `'${password.replace(/'/g, "''")}'`;
  await db.execute(sql.raw(`ALTER ROLE oicr_app WITH LOGIN PASSWORD ${literal}`));
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
