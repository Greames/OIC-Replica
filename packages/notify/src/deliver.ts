import { claimDueDeliveries, type Db, markDelivered, markDeliveryFailed } from "@oicr/db";
import { ATTR, recordError, SpanKind, withSpan } from "@oicr/platform";
import { type SendOptions, sendToChannel } from "./send.js";

/** Sends every due delivery once. Returns counts, for logs. */
export async function deliverDue(db: Db, opts: SendOptions & { batch?: number }) {
  const due = await claimDueDeliveries(db, opts.batch ?? 20);
  let sent = 0;
  let retry = 0;
  let failed = 0;
  await Promise.all(
    due.map((d) =>
      withSpan(
        "notify deliver",
        {
          [ATTR.tenant]: d.event.orgId,
          [ATTR.channel]: d.channel.kind,
          [ATTR.eventType]: d.event.type,
          [ATTR.attempt]: d.attempts,
        },
        async (span) => {
          const r = await sendToChannel(d.channel, d.event, opts, d.id);
          if (r.ok) {
            await markDelivered(db, d);
            sent++;
            return;
          }
          recordError(span, undefined, r.error ?? "failed");
          const outcome = await markDeliveryFailed(db, d, r.error ?? "failed", r.retryable ?? false);
          span.setAttribute("oicr.delivery_outcome", outcome);
          if (outcome === "retry") retry++;
          else failed++;
        },
        { kind: SpanKind.PRODUCER },
      ),
    ),
  );
  return { sent, retry, failed };
}
