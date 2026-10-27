import { v1 } from "@/lib/api-auth";
import { opSemanticCatalog } from "@/lib/ops";

export const dynamic = "force-dynamic";

/** GET /api/v1/catalog?system=oracle-ebs&entity=Customer — both filters optional. */
export const GET = v1(async (req, actor) => {
  const q = new URL(req.url).searchParams;
  return opSemanticCatalog(actor, { system: q.get("system") ?? undefined, entity: q.get("entity") ?? undefined });
});
