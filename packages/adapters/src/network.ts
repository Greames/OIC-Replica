import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";
import { AdapterError } from "./types.js";

// Outbound calls must not reach private networks (SSRF): cloud metadata,
// localhost, the database. The check runs at connect time on the resolved
// address, so DNS rebinding cannot slip past it.
// ALLOW_PRIVATE_NETWORK=true turns it off for local development and tests;
// on-prem systems will go through the connectivity agent instead.

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function privateNetworkAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORK === "true";
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return blocked.check(mapped[1], "ipv4");
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

function guardedLookup(hostname: string, options: object, callback: LookupCb): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as { address: string; family: number }[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) {
      const e = new Error(`blocked private address ${bad.address}`) as NodeJS.ErrnoException;
      e.code = "EBLOCKED";
      return callback(e, "");
    }
    const opts = options as { all?: boolean };
    if (opts.all) return callback(null, list);
    const first = list[0];
    if (!first) return callback(new Error(`no address for ${hostname}`), "");
    callback(null, first.address, first.family);
  });
}

let guarded: Agent | undefined;
let open: Agent | undefined;

/** The undici dispatcher every adapter must use for outbound HTTP. */
export function dispatcher(): Agent {
  if (privateNetworkAllowed()) {
    open ??= new Agent();
    return open;
  }
  guarded ??= new Agent({ connect: { lookup: guardedLookup as never } });
  return guarded;
}

/** Rejects literal private IPs early, with a clear message. Hostnames are checked at connect. */
export function assertPublicUrl(url: URL): void {
  if (privateNetworkAllowed()) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if ((isIP(host) && isBlockedAddress(host)) || host === "localhost" || host.endsWith(".localhost")) {
    throw new AdapterError(
      "private_network",
      `${url.hostname} is a private or local address. Connections can only reach public endpoints.`,
    );
  }
}
