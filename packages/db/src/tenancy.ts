import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

// Tenant isolation, enforced by Postgres row-level security (migration 0006).
// Every tenant table has a policy that only shows rows of the tenant in
// `app.tenant_id`, unless `app.bypass_rls` is on. Application code reaches
// tenant data only through:
//   asTenant(db, tenantId, fn)  a short transaction scoped to one tenant
//   asSystem(db, reason, fn)    a short transaction that may cross tenants, for the
//                               platform's own work (claiming due jobs, routing a
//                               trigger URL, checking an API key)
// Anything else sees no tenant rows at all: a forgotten WHERE org_id = … returns
// nothing instead of another tenant's data.
//
// The settings are transaction-local, so pooled connections never carry them
// over. They protect against application bugs, not against SQL injection
// (which could set them); queries stay parameterised.

interface Scope {
  tenant?: string;
  system?: boolean;
  root: Db;
}

const scopes = new WeakMap<object, Scope>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

class Refusal {
  constructor(readonly error: Error) {}
}

/**
 * Ends a scoped function with an error *after* committing what it wrote, for
 * "record it, then refuse" cases (a proposal marked stale, validation errors
 * saved). Use as `return refuse(new ConflictError(…))`. A thrown error would
 * roll those writes back with the transaction.
 */
export function refuse(error: Error): never {
  return new Refusal(error) as never;
}

async function settle<T>(run: () => Promise<T>): Promise<T> {
  const out = await run();
  if (out instanceof Refusal) throw out.error;
  return out;
}

/** The pool-level handle behind a scoped transaction (or the handle itself). */
export function rootDb(db: Db): Db {
  return scopes.get(db as unknown as object)?.root ?? db;
}

/** The tenant a handle is scoped to, if any. */
export function scopeOf(db: Db): { tenant?: string; system?: boolean } | undefined {
  const s = scopes.get(db as unknown as object);
  return s && { tenant: s.tenant, system: s.system };
}

/**
 * Runs `fn` with tenant-scoped access. Inside an existing scope for the same
 * tenant (or a system scope) it joins that transaction; inside another
 * tenant's scope it refuses.
 */
export async function asTenant<T>(db: Db, tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const scope = scopes.get(db as unknown as object);
  if (scope) {
    // Joining an outer transaction: the outer scope decides what commits.
    if (scope.system || scope.tenant === tenantId) return settle(() => fn(db));
    throw new TenantScopeError("Blocked a cross-tenant query inside another tenant's scope.");
  }
  if (!UUID.test(tenantId)) throw new TenantScopeError("Invalid tenant id.");
  return settle(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      const scoped = tx as unknown as Db;
      scopes.set(scoped as unknown as object, { tenant: tenantId, root: db });
      return fn(scoped);
    }),
  );
}

/**
 * Runs `fn` with access across tenants, for the platform's own jobs. Keep these
 * narrow: claim or route, then continue with `asTenant` for the tenant's work.
 */
export async function asSystem<T>(db: Db, reason: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const scope = scopes.get(db as unknown as object);
  if (scope?.system) return fn(db);
  if (scope) throw new TenantScopeError(`Blocked a system query (${reason}) inside a tenant scope.`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    const scoped = tx as unknown as Db;
    scopes.set(scoped as unknown as object, { system: true, root: db });
    return fn(scoped);
  });
}

/**
 * Whether row-level security actually applies to this connection's role.
 * Superusers and BYPASSRLS roles skip every policy, so the platform must not
 * run as one.
 */
export async function rlsStatus(db: Db): Promise<{ enforced: boolean; role: string; reason?: string }> {
  const rows = await db.execute<{ role: string; super: boolean; bypass: boolean }>(
    sql`select current_user as role, rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = current_user`,
  );
  const r = rows[0];
  if (!r) return { enforced: false, role: "unknown", reason: "role not found" };
  if (r.super) return { enforced: false, role: r.role, reason: "the database role is a superuser" };
  if (r.bypass) return { enforced: false, role: r.role, reason: "the database role has BYPASSRLS" };
  return { enforced: true, role: r.role };
}

/** Refuses to run where tenant isolation would silently not apply (production), or warns. */
export async function assertTenantIsolation(db: Db, log: (msg: string) => void = console.warn): Promise<void> {
  const s = await rlsStatus(db);
  if (s.enforced) return;
  const message = `Tenant isolation is not enforced: ${s.reason} (${s.role}). Connect as a regular role (see docs/platform-architecture.md).`;
  if (process.env.NODE_ENV === "production") throw new Error(message);
  log(message);
}
