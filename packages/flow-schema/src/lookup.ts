// Lookups: value maps between systems, e.g. country codes. A lookup has two
// or more domains (columns) and rows of values. Expressions use them as
//   $lookupValue("countries", "shop", $order.country, "erp")
//   $lookupValue("countries", "shop", $order.country, "erp", "XX")   default when not found

export interface LookupTable {
  name: string;
  domains: string[];
  rows: string[][];
}

export const LOOKUP_FUNCTION = "lookupValue";

export class LookupError extends Error {}

/** The value in domain `to` on the first row whose domain `from` equals `value`. */
export function lookupIn(table: LookupTable, from: string, value: unknown, to: string): string | undefined {
  const fi = table.domains.indexOf(from);
  const ti = table.domains.indexOf(to);
  if (fi < 0 || ti < 0) {
    const bad = fi < 0 ? from : to;
    throw new LookupError(
      `Lookup "${table.name}" has no domain "${bad}". Its domains are: ${table.domains.join(", ")}.`,
    );
  }
  const needle = String(value);
  const row = table.rows.find((r) => (r[fi] ?? "") === needle);
  const found = row?.[ti];
  return found === undefined || found === "" ? undefined : found;
}

/**
 * The $lookupValue function for JSONata bindings. `load` finds a lookup by
 * name (null: it does not exist); each name is loaded once per function.
 * A list of values gives a list of results.
 */
export function lookupFunction(load: (name: string) => Promise<LookupTable | null> | LookupTable | null) {
  const cache = new Map<string, Promise<LookupTable | null>>();
  return async (name: unknown, from: unknown, value: unknown, to: unknown, fallback?: unknown): Promise<unknown> => {
    if (typeof name !== "string" || typeof from !== "string" || typeof to !== "string")
      throw new LookupError('Use $lookupValue("lookup", "from domain", value, "to domain", default?).');
    let p = cache.get(name);
    if (!p) {
      p = Promise.resolve(load(name));
      cache.set(name, p);
    }
    const table = await p;
    if (!table) throw new LookupError(`Lookup "${name}" does not exist.`);
    const one = (v: unknown) => {
      if (v === undefined || v === null) return fallback;
      return lookupIn(table, from, v, to) ?? fallback;
    };
    return Array.isArray(value) ? value.map(one) : one(value);
  };
}
