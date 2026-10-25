// A tiny API for e2e tests: orders to read, a shop to write to.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_API_PORT ?? 4010);
const received = [];
// Webhook deliveries (notification channels), with their headers.
const hooks = [];

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/_received") return send(200, received);
    if (req.url === "/_hooks") return send(200, hooks);
    if (req.method === "POST" && req.url?.startsWith("/hooks/")) {
      hooks.push({ path: req.url, headers: req.headers, body });
      return send(202, { ok: true });
    }
    if (req.headers["x-api-key"] !== "k-123") return send(401, { error: "bad key" });
    if (req.url === "/health") return send(200, { ok: true });
    if (req.method === "GET" && req.url === "/orders") {
      return send(200, {
        orders: [
          { id: "A1", total: 10 },
          { id: "A2", total: -1 },
        ],
      });
    }
    if (req.method === "POST" && req.url === "/shop/orders") {
      const parsed = JSON.parse(body || "{}");
      received.push(parsed);
      if (parsed.total_cents < 0) return send(422, { error: "negative total" });
      return send(201, { shopId: `S-${parsed.external_id}` });
    }
    send(404, { error: "not found" });
  });
}).listen(port, "127.0.0.1", () => console.log(`mock api on ${port}`));
