import { rest } from "./rest.js";
import type { Adapter } from "./types.js";

export * from "./network.js";
export * from "./rest.js";
export * from "./types.js";

/** Every adapter, by id. Phase 7 adds sftp, postgres, mysql, soap, email. */
export const adapters: Record<string, Adapter<any>> = { rest };

export function getAdapter(id: string): Adapter<any> {
  const a = adapters[id];
  if (!a) throw new Error(`Unknown adapter "${id}".`);
  return a;
}
