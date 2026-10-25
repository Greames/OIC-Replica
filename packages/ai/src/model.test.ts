import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicModel, systemPrompt, TOOLS } from "./index.js";

// A local stand-in for the Messages API: records the request, streams back a
// tool_use turn. Checks the request shape and the streaming parse offline.

let server: Server;
let seen: { url?: string; headers: IncomingHttpHeaders; body: any } | null = null;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse("message_start", {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        }),
      );
      res.write(
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      res.write(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Checking " },
        }),
      );
      res.write(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "connections." },
        }),
      );
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(
        sse("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu_1", name: "list_connections", input: {} },
        }),
      );
      res.write(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{}" },
        }),
      );
      res.write(sse("content_block_stop", { type: "content_block_stop", index: 1 }));
      res.write(
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 20 },
        }),
      );
      res.write(sse("message_stop", { type: "message_stop" }));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  delete process.env.ANTHROPIC_BASE_URL;
});

describe("AnthropicModel", () => {
  it("sends a well-formed streaming request and returns the parsed turn", async () => {
    const model = new AnthropicModel({ apiKey: "test-key" });
    const text: string[] = [];
    const msg = await model.turn(
      { system: systemPrompt(), tools: TOOLS, messages: [{ role: "user", content: "hi" }] },
      { onText: (d) => text.push(d) },
    );

    expect(seen?.url).toMatch(/^\/v1\/messages/);
    expect(String(seen?.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    const body = seen!.body;
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      max_tokens: 64000,
      fallbacks: "default",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
    });
    expect(body.betas).toBeUndefined(); // betas travel as a header, not in the body
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toBeUndefined(); // forced tool choice is not allowed on this model
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools.find((t: { name: string }) => t.name === "propose_flow").eager_input_streaming).toBe(true);

    expect(text.join("")).toBe("Checking connections.");
    expect(msg.stop_reason).toBe("tool_use");
    expect(msg.content.find((b) => b.type === "tool_use")).toMatchObject({ name: "list_connections", input: {} });
  });

  it("honours AI_MODEL and AI_EFFORT, and ignores empty values", () => {
    process.env.AI_MODEL = "";
    expect(new AnthropicModel({ apiKey: "k" }).model).toBe("claude-opus-5-5");
    process.env.AI_MODEL = "claude-sonnet-5-5";
    expect(new AnthropicModel({ apiKey: "k" }).model).toBe("claude-sonnet-5-5");
    delete process.env.AI_MODEL;
  });
});
