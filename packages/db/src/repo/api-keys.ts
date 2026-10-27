import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../client.js";
import { API_SCOPES, type ApiScope, apiKeys } from "../schema/events.js";
import { asSystem, asTenant } from "../tenancy.js";
import { type Actor, assertCan, NotFoundError } from "./access.js";

// API keys for the public API and the MCP server. Format: oicr_<prefix>_<secret>.
// Only the sha256 is stored; the full key is shown once.

export const NewApiKey = z.object({
  name: z.string().trim().min(1, "Name the key, e.g. Hermes Agent.").max(80),
  scopes: z.array(z.enum(API_SCOPES)).default(["read"]),
});

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export async function createApiKey(db: Db, actor: Actor, input: z.input<typeof NewApiKey>) {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "admin");
    const data = NewApiKey.parse(input);
    const scopes = [...new Set<ApiScope>(["read", ...data.scopes])];
    const prefix = randomBytes(4).toString("hex");
    const key = `oicr_${prefix}_${randomBytes(24).toString("base64url")}`;
    const [row] = await db
      .insert(apiKeys)
      .values({ orgId: actor.orgId, name: data.name, prefix, hash: hash(key), scopes, createdBy: actor.userId })
      .returning();
    return { key, apiKey: { ...row!, hash: undefined } };
  });
}

export async function listApiKeys(db: Db, actor: Actor) {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "admin");
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.orgId, actor.orgId)).orderBy(desc(apiKeys.createdAt));
    return rows.map(({ hash: _h, ...r }) => r);
  });
}

export async function revokeApiKey(db: Db, actor: Actor, id: string): Promise<void> {
  return asTenant(db, actor.orgId, async (db) => {
    assertCan(actor, "admin");
    const r = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.orgId, actor.orgId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (r.length === 0) throw new NotFoundError("API key");
  });
}

/**
 * Turns "Bearer oicr_…" into an Actor limited to the key's scopes, or null.
 * The actor acts as a developer of the org, narrowed by scopes; it can never
 * do admin things (members, channels, keys).
 */
export async function authenticateApiKey(
  db: Db,
  authorization: string | null | undefined,
): Promise<(Actor & { keyId: string; keyName: string }) | null> {
  return asSystem(db, "authenticateApiKey", async (db) => {
    const key = authorization?.match(/^Bearer\s+(oicr_[0-9a-f]{8}_[\w-]+)$/i)?.[1];
    if (!key) return null;
    const prefix = key.split("_")[1]!;
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)));
    if (!row) return null;
    const a = Buffer.from(hash(key));
    const b = Buffer.from(row.hash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch(() => {});
    return {
      userId: row.createdBy ?? row.id,
      orgId: row.orgId,
      role: "developer",
      scopes: row.scopes as ApiScope[],
      keyId: row.id,
      keyName: row.name,
    };
  });
}
