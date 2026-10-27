import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;

/**
 * One pool per process. Pass DATABASE_URL, or a URL for tests.
 * `migrations: true` is for schema migrations only: the connection skips
 * tenant isolation (app.bypass_rls) so migrations can backfill across tenants.
 */
export function createDb(url = process.env.DATABASE_URL, opts: { migrations?: boolean } = {}) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, {
    max: opts.migrations ? 1 : Number(process.env.DATABASE_POOL_MAX ?? 10),
    onnotice: () => {},
    connection: {
      application_name: opts.migrations ? "oicr-migrate" : "oicr",
      ...(opts.migrations ? { "app.bypass_rls": "on" } : {}),
    },
  });
  return Object.assign(drizzle(client, { schema, casing: "snake_case" }), { $client: client });
}
