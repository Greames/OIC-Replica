import { v1 } from "@/lib/api-auth";
import { opActivate, uuidParam } from "@/lib/ops";

export const dynamic = "force-dynamic";

export const POST = v1<{ id: string }>(async (_req, actor, { id }) => opActivate(actor, uuidParam(id)));
