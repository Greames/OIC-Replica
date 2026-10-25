import { v1 } from "@/lib/api-auth";
import { OpError, opListRuns, opRun, uuidParam } from "@/lib/ops";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = v1<{ id: string }>(async (req, actor, { id }) => {
  const q = new URL(req.url).searchParams;
  return opListRuns(actor, {
    integration_id: uuidParam(id),
    status: (q.get("status") ?? undefined) as never,
    before: q.get("before") ?? undefined,
    limit: q.get("limit") ?? undefined,
  });
});

/** POST /api/v1/integrations/:id/runs with the run's input as the JSON body. */
export const POST = v1<{ id: string }>(async (req, actor, { id }) => {
  const text = await req.text();
  let input: unknown = {};
  if (text.trim()) {
    try {
      input = JSON.parse(text);
    } catch {
      throw new OpError(400, "invalid", "The body is not valid JSON.");
    }
  }
  return opRun(actor, uuidParam(id), input);
});
