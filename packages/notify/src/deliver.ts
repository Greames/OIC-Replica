import { claimDueDeliveries, type Db, markDelivered, markDeliveryFailed } from "@oicr/db";
import { type SendOptions, sendToChannel } from "./send.js";

/** Sends every due delivery once. Returns counts, for logs. */
export async function deliverDue(db: Db, opts: SendOptions & { batch?: number }) {
  const due = await claimDueDeliveries(db, opts.batch ?? 20);
  let sent = 0;
  let retry = 0;
  let failed = 0;
  await Promise.all(
    due.map(async (d) => {
      const r = await sendToChannel(d.channel, d.event, opts, d.id);
      if (r.ok) {
        await markDelivered(db, d);
        sent++;
      } else if ((await markDeliveryFailed(db, d, r.error ?? "failed", r.retryable ?? false)) === "retry") retry++;
      else failed++;
    }),
  );
  return { sent, retry, failed };
}
