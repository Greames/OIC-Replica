import { v1 } from "@/lib/api-auth";
import { opListRuns } from "@/lib/ops";

export const dynamic = "force-dynamic";

/** GET /api/v1/runs?status=failed&integration_id=…&business_id=…&before=…&limit=20 — newest first. */
export const GET = v1(async (req, actor) => {
  const q = Object.fromEntries(new URL(req.url).searchParams);
  return opListRuns(actor, q);
});
