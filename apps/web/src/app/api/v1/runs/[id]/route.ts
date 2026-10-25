import { v1 } from "@/lib/api-auth";
import { opGetRun, uuidParam } from "@/lib/ops";

export const dynamic = "force-dynamic";

export const GET = v1<{ id: string }>(async (_req, actor, { id }) => opGetRun(actor, uuidParam(id)));
