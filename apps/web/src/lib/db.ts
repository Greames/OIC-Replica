import { createDb, type Db } from "@oicr/db";

// One pool per server process, kept across hot reloads in dev. Created on
// first use, so `next build` (and the Docker build) need no DATABASE_URL.
const g = globalThis as unknown as { __oicrDb?: Db };

function instance(): Db {
  g.__oicrDb ??= createDb();
  return g.__oicrDb;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = instance();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
