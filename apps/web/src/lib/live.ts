import "server-only";
import { EVENTS_CHANNEL, type Event, getEventForOrg } from "@oicr/db";
import { db } from "./db";

// One LISTEN connection per server process fans events out to the browsers
// of the org they belong to (Server-Sent Events).

type Listener = (event: Event) => void;
const g = globalThis as unknown as { __oicrLive?: { listeners: Map<string, Set<Listener>>; ready: Promise<void> } };

function hub() {
  if (!g.__oicrLive) {
    const listeners = new Map<string, Set<Listener>>();
    const ready = db.$client
      .listen(EVENTS_CHANNEL, async (payload) => {
        try {
          const { orgId, id } = JSON.parse(payload) as { orgId: string; id: number };
          const set = listeners.get(orgId);
          if (!set?.size) return;
          const event = await getEventForOrg(db, orgId, id);
          if (event) for (const l of set) l(event);
        } catch (e) {
          console.error("[live]", (e as Error).message);
        }
      })
      .then(() => undefined)
      .catch((e) => {
        // Try again on the next subscriber instead of staying broken.
        g.__oicrLive = undefined;
        throw e;
      });
    g.__oicrLive = { listeners, ready };
  }
  return g.__oicrLive;
}

export async function subscribe(orgId: string, listener: Listener): Promise<() => void> {
  const h = hub();
  await h.ready;
  const set = h.listeners.get(orgId) ?? new Set<Listener>();
  set.add(listener);
  h.listeners.set(orgId, set);
  return () => {
    set.delete(listener);
  };
}
