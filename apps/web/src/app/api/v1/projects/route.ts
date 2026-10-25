import { v1 } from "@/lib/api-auth";
import { opListProjects } from "@/lib/ops";

export const dynamic = "force-dynamic";

export const GET = v1(async (_req, actor) => ({ projects: await opListProjects(actor) }));
