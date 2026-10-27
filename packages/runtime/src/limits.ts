import { type Db, getTenantLimits, type TenantLimits } from "@oicr/db";

// Tenant limits change rarely; every enqueue and trigger reads them, so they
// are cached per process for a minute.

const TTL_MS = 60_000;
const cache = new Map<string, { value: TenantLimits; expires: number }>();

export async function tenantLimits(db: Db, orgId: string): Promise<TenantLimits> {
  const hit = cache.get(orgId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await getTenantLimits(db, orgId);
  if (cache.size > 50_000) cache.clear();
  cache.set(orgId, { value, expires: Date.now() + TTL_MS });
  return value;
}

/** Defaults per tier when a tenant has no override (env-configurable). */
export const TIER_DEFAULTS = {
  standard: {
    runs: Number(process.env.TIER_STANDARD_RUNS ?? 4),
    sync: Number(process.env.TIER_STANDARD_SYNC ?? 16),
    rps: Number(process.env.TIER_STANDARD_RPS ?? 50),
  },
  business: {
    runs: Number(process.env.TIER_BUSINESS_RUNS ?? 16),
    sync: Number(process.env.TIER_BUSINESS_SYNC ?? 64),
    rps: Number(process.env.TIER_BUSINESS_RPS ?? 200),
  },
  dedicated: {
    runs: Number(process.env.TIER_DEDICATED_RUNS ?? 64),
    sync: Number(process.env.TIER_DEDICATED_SYNC ?? 256),
    rps: Number(process.env.TIER_DEDICATED_RPS ?? 1000),
  },
} as const;

/** pg-boss group concurrency for queued runs: per tenant, across all workers, by tier. */
export function runGroupConcurrency() {
  return {
    default: TIER_DEFAULTS.standard.runs,
    tiers: { business: TIER_DEFAULTS.business.runs, dedicated: TIER_DEFAULTS.dedicated.runs },
  };
}
