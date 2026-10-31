import { database } from "./database/index.js";
import { rest } from "./rest.js";
import type { Adapter } from "./types.js";

export * from "./database/index.js";
export * from "./network.js";
export * from "./rest.js";
export * from "./types.js";

/** Every adapter, by id. */
export const adapters: Record<string, Adapter<any>> = { rest, database };

/** Batch read/write operations per adapter id, for validating pipeline steps. */
export function batchOperations(): Record<string, { read: string[]; write: string[] }> {
  return Object.fromEntries(
    Object.values(adapters)
      .filter((a) => a.batch)
      .map((a) => [a.id, { read: a.batch!.readOperations, write: a.batch!.writeOperations }]),
  );
}

/** Releases every adapter's pooled connections (process shutdown). */
export async function closeAdapters(): Promise<void> {
  await Promise.all(Object.values(adapters).map((a) => a.close?.()));
}

export function getAdapter(id: string): Adapter<any> {
  const a = adapters[id];
  if (!a) throw new Error(`Unknown adapter "${id}".`);
  return a;
}
