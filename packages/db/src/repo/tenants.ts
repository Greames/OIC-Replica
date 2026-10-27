import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { type TENANT_TIERS, tenantLimits } from "../schema/runtime.js";
import { asTenant } from "../tenancy.js";

export type TenantTier = (typeof TENANT_TIERS)[number];

export interface TenantLimits {
  /** Queued runs: concurrency comes from the tier (a worker setting), across all workers. */
  tier: TenantTier;
  /** Concurrent synchronous calls per stream engine instance; null: the tier default. */
  syncConcurrency: number | null;
  /** Trigger requests per second per stream engine instance; null: the tier default. */
  requestsPerSecond: number | null;
}

const STANDARD: TenantLimits = { tier: "standard", syncConcurrency: null, requestsPerSecond: null };

/** A tenant's execution limits. */
export async function getTenantLimits(db: Db, orgId: string): Promise<TenantLimits> {
  return asTenant(db, orgId, async (db) => {
    const [row] = await db.select().from(tenantLimits).where(eq(tenantLimits.orgId, orgId));
    return row
      ? { tier: row.tier, syncConcurrency: row.syncConcurrency, requestsPerSecond: row.requestsPerSecond }
      : STANDARD;
  });
}

/** Sets a tenant's tier and overrides (an operator action; no admin console yet). */
export async function setTenantLimits(db: Db, orgId: string, limits: Partial<TenantLimits>): Promise<void> {
  await asTenant(db, orgId, async (db) => {
    await db
      .insert(tenantLimits)
      .values({ orgId, ...limits })
      .onConflictDoUpdate({ target: tenantLimits.orgId, set: { ...limits, updatedAt: new Date() } });
  });
}
