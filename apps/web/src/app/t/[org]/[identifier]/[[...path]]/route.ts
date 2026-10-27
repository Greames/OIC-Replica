// /t/... belongs to the stream engine (apps/stream), which runs integrations
// apart from the web app. This route only forwards to it, so trigger URLs on
// the app's own address keep working; production ingress can route /t/ to the
// stream engine directly.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);

async function forward(req: Request): Promise<Response> {
  const target = (process.env.STREAM_URL || "http://localhost:3001").replace(/\/$/, "");
  const url = new URL(req.url);
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k)) headers.set(k, v);
  });
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  let res: Response;
  try {
    res = await fetch(`${target}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
  } catch {
    return Response.json(
      { error: "unavailable", message: "The integration runtime is not reachable. Retry shortly." },
      { status: 503, headers: { "retry-after": "2" } },
    );
  }
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k)) out.set(k, v);
  });
  return new Response(res.body, { status: res.status, headers: out });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
