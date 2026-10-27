import { v1 } from "@/lib/api-auth";
import { opListLookups } from "@/lib/ops";

export const dynamic = "force-dynamic";

/** GET /api/v1/lookups?rows=1 — with rows=1, every row is included. */
export const GET = v1(async (req, actor) => ({
  lookups: await opListLookups(actor, { rows: new URL(req.url).searchParams.get("rows") === "1" }),
}));
