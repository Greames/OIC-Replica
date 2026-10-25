import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM. Layout: [version=1][iv 12][tag 16][ciphertext]. The version byte
// leaves room for key rotation. Secrets never leave the server and are never
// returned by the API or shown to the AI builder.

const VERSION = 1;

function key(): Buffer {
  const raw = process.env.SECRETS_KEY;
  if (!raw) throw new Error("SECRETS_KEY is not set. Generate one with: openssl rand -base64 32");
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes (base64 or hex).");
  return buf;
}

export function encryptSecret(value: unknown): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptSecret<T = unknown>(blob: Buffer | Uint8Array): T {
  const buf = Buffer.from(blob);
  if (buf[0] !== VERSION) throw new Error("Unknown secret format.");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(1, 13));
  decipher.setAuthTag(buf.subarray(13, 29));
  const text = Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8");
  return JSON.parse(text) as T;
}
