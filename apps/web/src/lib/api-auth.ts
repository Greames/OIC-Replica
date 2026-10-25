import "server-only";
import { type Actor, authenticateApiKey } from "@oicr/db";
import { db } from "./db";
import { type OpError, toOpError } from "./ops";

export type KeyActor = Actor & { keyId: string; keyName: string };

/** The API key's actor, or a 401 to return. */
export async function apiActor(req: Request): Promise<KeyActor | Response> {
  const actor = await authenticateApiKey(db, req.headers.get("authorization"));
  if (actor) return actor;
  return Response.json(
    {
      error: "unauthorized",
      message: "Send an API key: Authorization: Bearer oicr_… (create one in Settings → API keys).",
    },
    { status: 401, headers: { "www-authenticate": 'Bearer realm="oic-replica"' } },
  );
}

export function opErrorResponse(e: unknown): Response {
  const err: OpError = toOpError(e);
  return Response.json({ error: err.code, message: err.message }, { status: err.status });
}

/** Wraps a v1 handler: authenticates, runs, turns known errors into JSON. */
export function v1<P>(handler: (req: Request, actor: KeyActor, params: P) => Promise<unknown>) {
  return async (req: Request, ctx: { params: Promise<P> }) => {
    const actor = await apiActor(req);
    if (actor instanceof Response) return actor;
    try {
      return Response.json(await handler(req, actor, await ctx.params));
    } catch (e) {
      return opErrorResponse(e);
    }
  };
}
