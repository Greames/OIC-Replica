import { v1 } from "@/lib/api-auth";
import { opListIntegrations } from "@/lib/ops";

export const dynamic = "force-dynamic";

export const GET = v1(async (req, actor) => {
  const projectId = new URL(req.url).searchParams.get("project_id") ?? undefined;
  return { integrations: await opListIntegrations(actor, { project_id: projectId }) };
});
