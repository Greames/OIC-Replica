import {
  assertRef,
  cachedStore,
  type SecretRef,
  type SecretStore,
  SecretStoreError,
  type SecretValue,
  VaultClient,
  VaultSecretStore,
  vaultOptionsFromEnv,
} from "@oicr/vault";
import { and, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { devSecrets } from "./schema/secrets.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

export type { SecretRef, SecretStore };

/** Development/test backend: encrypted rows in `dev_secrets`. Never used in production. */
export class DatabaseSecretStore implements SecretStore {
  readonly backend = "database";
  constructor(private readonly db: Db) {}

  async put(ref: SecretRef, value: SecretValue): Promise<void> {
    assertRef(ref);
    const ciphertext = encryptSecret(value);
    await this.db
      .insert(devSecrets)
      .values({ tenant: ref.tenant, kind: ref.kind, id: ref.id, ciphertext })
      .onConflictDoUpdate({
        target: [devSecrets.tenant, devSecrets.kind, devSecrets.id],
        set: { ciphertext, updatedAt: new Date() },
      });
  }

  async get<T extends SecretValue = SecretValue>(ref: SecretRef): Promise<T | null> {
    assertRef(ref);
    const [row] = await this.db
      .select({ ciphertext: devSecrets.ciphertext })
      .from(devSecrets)
      .where(and(eq(devSecrets.tenant, ref.tenant), eq(devSecrets.kind, ref.kind), eq(devSecrets.id, ref.id)));
    if (!row) return null;
    try {
      return decryptSecret<T>(row.ciphertext);
    } catch {
      throw new SecretStoreError(
        "misconfigured",
        "A stored credential could not be decrypted. If SECRETS_KEY changed, enter it again.",
      );
    }
  }

  async delete(ref: SecretRef): Promise<void> {
    assertRef(ref);
    await this.db
      .delete(devSecrets)
      .where(and(eq(devSecrets.tenant, ref.tenant), eq(devSecrets.kind, ref.kind), eq(devSecrets.id, ref.id)));
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    try {
      encryptSecret({ probe: true });
      return { ok: true, message: "Database backend (development only)." };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}

const stores = new WeakMap<object, SecretStore>();

/**
 * The configured secret store for a database handle:
 * - `vault` when SECRETS_BACKEND=vault, or when VAULT_ADDR is set;
 * - `database` otherwise, except in production, where it is refused.
 * Vault reads are cached for VAULT_CACHE_TTL_MS (default 60 s).
 */
export function secretStore(db: Db, env: NodeJS.ProcessEnv = process.env): SecretStore {
  const key = db as unknown as object;
  const existing = stores.get(key);
  if (existing) return existing;
  const backend = env.SECRETS_BACKEND || (env.VAULT_ADDR ? "vault" : "database");
  let store: SecretStore;
  if (backend === "vault") {
    const opts = vaultOptionsFromEnv(env);
    if (!opts) throw new SecretStoreError("misconfigured", "SECRETS_BACKEND=vault needs VAULT_ADDR.");
    store = cachedStore(new VaultSecretStore(new VaultClient(opts)), {
      ttlMs: Number(env.VAULT_CACHE_TTL_MS ?? 60_000),
    });
  } else if (backend === "database") {
    if (env.NODE_ENV === "production")
      throw new SecretStoreError(
        "misconfigured",
        "Customer credentials must be kept in Vault in production. Set VAULT_ADDR and Vault credentials (see docs/platform-architecture.md).",
      );
    store = new DatabaseSecretStore(db);
  } else {
    throw new SecretStoreError(
      "misconfigured",
      `Unknown SECRETS_BACKEND "${backend}". Use vault (or database for development).`,
    );
  }
  stores.set(key, store);
  return store;
}

/** Tests and tools: use a specific store for a database handle. */
export function useSecretStore(db: Db, store: SecretStore): void {
  stores.set(db as unknown as object, store);
}
