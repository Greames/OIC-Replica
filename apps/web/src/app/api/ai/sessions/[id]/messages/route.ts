import { type AiEvent, runTurn } from "@oicr/ai";
import { ConflictError } from "@oicr/db";
import { z } from "zod";
import { getModel } from "@/lib/ai";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ text: z.string().trim().min(1).max(8000) });

/**
 * Sends a message to the AI builder and streams its work back as
 * Server-Sent Events (text deltas, tool activity, questions, proposals).
 * The turn finishes and is saved even if the browser disconnects.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  const viewer = await requireViewer();
  const model = getModel();
  if (!model)
    return Response.json(
      { error: "ai_disabled", message: "Set ANTHROPIC_API_KEY to use the AI builder." },
      { status: 503 },
    );
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: "invalid", message: "Write a message first." }, { status: 400 });

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AiEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      runTurn({ db, actor: viewer, sessionId: id, text: body.data.text, model, emit: send })
        .catch((e) => {
          send({ type: "error", message: e instanceof ConflictError ? e.message : "Something went wrong." });
          send({ type: "done", status: "error" });
        })
        .finally(() => {
          if (!closed) controller.close();
          closed = true;
        });
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
