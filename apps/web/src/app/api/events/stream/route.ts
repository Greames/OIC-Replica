import { subscribe } from "@/lib/live";
import { requireViewer } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Live events for the signed-in workspace, as Server-Sent Events. */
export async function GET(req: Request) {
  const viewer = await requireViewer();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(": connected\n\n");
      const unsubscribe = await subscribe(viewer.orgId, (e) => {
        send(
          `id: ${e.id}\nevent: update\ndata: ${JSON.stringify({ id: e.id, type: e.type, severity: e.severity, summary: e.summary, path: e.path, data: e.data })}\n\n`,
        );
      });
      const ping = setInterval(() => send(": ping\n\n"), 25_000);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
