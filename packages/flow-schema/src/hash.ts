/** JSON with object keys sorted, so equal documents give equal text. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * sha256 of the stable JSON, hex. Used as `definition_hash` to detect edits
 * between an AI proposal and its apply, and for save conflicts (409).
 * Web Crypto, so it runs in Node 22 and the browser.
 */
export async function hashFlow(doc: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(doc));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
