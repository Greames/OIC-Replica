import { v1 } from "@/lib/api-auth";
import { opListEvents } from "@/lib/ops";

export const dynamic = "force-dynamic";

/** GET /api/v1/events?since_id=N&types=instance.failed,ai.question&limit=100 — oldest first after the cursor. */
export const GET = v1(async (req, actor) => {
  const q = new URL(req.url).searchParams;
  const types = q
    .get("types")
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return opListEvents(actor, { since_id: q.get("since_id") ?? undefined, types, limit: q.get("limit") ?? undefined });
});
