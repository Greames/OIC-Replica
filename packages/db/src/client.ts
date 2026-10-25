import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;

/** One pool per process. Pass DATABASE_URL, or a URL for tests. */
export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
  return Object.assign(drizzle(client, { schema, casing: "snake_case" }), { $client: client });
}
