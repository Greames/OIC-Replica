// Payloads are kept in Postgres, capped, until object storage arrives.

export const PAYLOAD_LIMITS = { audit: 64 * 1024, debug: 1024 * 1024 } as const;

export interface TruncatedPayload {
  _truncated: true;
  sizeBytes: number;
  preview: string;
}

export function capPayload(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value) ?? "null";
  const size = Buffer.byteLength(text);
  if (size <= maxBytes) return value;
  return { _truncated: true, sizeBytes: size, preview: text.slice(0, 2000) } satisfies TruncatedPayload;
}
