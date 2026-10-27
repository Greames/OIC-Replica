import { customType, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * The `database` secret backend, for local development and tests only: it is
 * refused when NODE_ENV=production, where credentials must live in Vault.
 * Values are AES-256-GCM encrypted with SECRETS_KEY.
 */
export const devSecrets = pgTable(
  "dev_secrets",
  {
    tenant: uuid("tenant").notNull(),
    kind: text("kind").notNull(),
    id: text("id").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenant, t.kind, t.id] })],
);
