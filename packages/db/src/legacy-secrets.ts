import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { maskChannelTarget } from "./repo/channels.js";
import { hashTriggerToken } from "./repo/integrations.js";
import { notificationChannels } from "./schema/events.js";
import { connections, integrations } from "./schema/runtime.js";
import type { SecretStore } from "./secret-store.js";
import { decryptSecret } from "./secrets.js";

export interface LegacyMoveReport {
  connections: number;
  channels: number;
  triggerTokens: number;
  /**
   * Rows that were not moved. `permanent`: the ciphertext cannot be decrypted
   * with the current SECRETS_KEY (left untouched, in case the right key comes
   * back); otherwise the store failed and a rerun can succeed.
   */
  failed: { table: string; id: string; error: string; permanent: boolean }[];
}

/** Decrypts a legacy value, telling a wrong key (permanent) from everything else. */
function open<T>(blob: Buffer): { ok: true; value: T } | { ok: false; error: string; permanent: boolean } {
  if (!process.env.SECRETS_KEY)
    return { ok: false, error: "SECRETS_KEY is needed to move legacy secrets.", permanent: false };
  try {
    return { ok: true, value: decryptSecret<T>(blob) };
  } catch (e) {
    return {
      ok: false,
      error: `Cannot decrypt with the current SECRETS_KEY (${(e as Error).message}).`,
      permanent: true,
    };
  }
}

/**
 * Moves pre-v2 credentials out of the primary database: connection secrets
 * and channel settings into the secret store, trigger tokens to hashes. Each
 * row is written to the store first and only then emptied, so a failure can
 * be retried without losing anything. Idempotent; does nothing (and needs no
 * SECRETS_KEY) when no legacy data is left.
 */
export async function moveLegacySecrets(db: Db, store: SecretStore): Promise<LegacyMoveReport> {
  const report: LegacyMoveReport = { connections: 0, channels: 0, triggerTokens: 0, failed: [] };

  const conns = await db
    .select({ id: connections.id, orgId: connections.orgId, blob: connections.secretCiphertext })
    .from(connections)
    .where(isNotNull(connections.secretCiphertext));
  for (const c of conns) {
    const opened = open<Record<string, unknown>>(c.blob!);
    if (!opened.ok) {
      report.failed.push({ table: "connections", id: c.id, error: opened.error, permanent: opened.permanent });
      continue;
    }
    try {
      await store.put({ tenant: c.orgId, kind: "connection", id: c.id }, opened.value);
      await db.update(connections).set({ secretCiphertext: null, hasSecret: true }).where(eq(connections.id, c.id));
      report.connections++;
    } catch (e) {
      report.failed.push({ table: "connections", id: c.id, error: (e as Error).message, permanent: false });
    }
  }

  const chans = await db
    .select({
      id: notificationChannels.id,
      orgId: notificationChannels.orgId,
      kind: notificationChannels.kind,
      blob: notificationChannels.configCiphertext,
    })
    .from(notificationChannels)
    .where(isNotNull(notificationChannels.configCiphertext));
  for (const ch of chans) {
    const opened = open<Record<string, unknown>>(ch.blob!);
    if (!opened.ok) {
      report.failed.push({
        table: "notification_channels",
        id: ch.id,
        error: opened.error,
        permanent: opened.permanent,
      });
      continue;
    }
    try {
      const config = opened.value;
      await store.put({ tenant: ch.orgId, kind: "channel", id: ch.id }, config);
      await db
        .update(notificationChannels)
        .set({ configCiphertext: null, target: maskChannelTarget(ch.kind, config) })
        .where(eq(notificationChannels.id, ch.id));
      report.channels++;
    } catch (e) {
      report.failed.push({ table: "notification_channels", id: ch.id, error: (e as Error).message, permanent: false });
    }
  }

  const tokens = await db
    .select({ id: integrations.id, blob: integrations.triggerTokenCiphertext })
    .from(integrations)
    .where(isNotNull(integrations.triggerTokenCiphertext));
  for (const t of tokens) {
    const opened = open<string>(t.blob!);
    if (!opened.ok) {
      report.failed.push({ table: "integrations", id: t.id, error: opened.error, permanent: opened.permanent });
      continue;
    }
    try {
      const token = opened.value;
      await db
        .update(integrations)
        .set({
          triggerTokenHash: hashTriggerToken(token),
          triggerTokenHint: token.slice(-4),
          triggerTokenCiphertext: null,
        })
        .where(eq(integrations.id, t.id));
      report.triggerTokens++;
    } catch (e) {
      report.failed.push({ table: "integrations", id: t.id, error: (e as Error).message, permanent: false });
    }
  }
  return report;
}
