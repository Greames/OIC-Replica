import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

/** Applies pending migrations. `pnpm db:migrate`, and on deploy before the app starts. */
export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  const db = createDb(url);
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
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
