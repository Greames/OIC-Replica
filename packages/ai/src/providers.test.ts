import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageParam, TurnRequest } from "./model.js";
import { ModelError, ToolInputParseError } from "./model.js";
import {
  aiSetupHint,
  configuredProvider,
  fromOpenAIResponse,
  GeminiCollector,
  GeminiModel,
  modelFromEnv,
  OpenAIModel,
  toAnthropicMessages,
  toGeminiContents,
  toOpenAIInput,
} from "./providers/index.js";

const history = [
  { role: "user", content: [{ type: "text", text: "Build it" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan", signature: "", provider_data: { gemini: { thoughtSignature: "SIG-T" } } },
      {
        type: "thinking",
        thinking: "gpt thoughts",
        signature: "",
        provider_data: { openai: { item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" } } },
      },
      { type: "text", text: "Checking." },
      {
        type: "tool_use",
        id: "c1",
        name: "list_connections",
        input: {},
        provider_data: { gemini: { thoughtSignature: "SIG-1" } },
      },
      { type: "tool_use", id: "c2", name: "list_lookups", input: {}, provider_data: { gemini: { generatedId: true } } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "c1", content: "[]" },
      { type: "tool_result", tool_use_id: "c2", content: [{ type: "text", text: "none" }], is_error: true },
    ],
  },
  { role: "assistant", content: [{ type: "tool_use", id: "x9", name: "get_flow", input: { a: 1 } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "x9", content: "{}" }] },
] as unknown as MessageParam[];

describe("Gemini translation", () => {
  it("sends thoughts, signatures, calls and results the way Gemini expects", () => {
    const c = toGeminiContents(history);
    expect(c.map((x) => x.role)).toEqual(["user", "model", "user", "model", "user"]);
    expect(c[1]!.parts).toEqual([
      { text: "plan", thought: true, thoughtSignature: "SIG-T" },
      { text: "Checking." },
      { functionCall: { id: "c1", name: "list_connections", args: {} }, thoughtSignature: "SIG-1" },
      { functionCall: { name: "list_lookups", args: {} } },
    ]);
    expect(c[2]!.parts).toEqual([
      { functionResponse: { id: "c1", name: "list_connections", response: { output: "[]" } } },
      { functionResponse: { name: "list_lookups", response: { error: "none" } } },
    ]);
    // A call from another provider gets the placeholder signature.
    expect(c[3]!.parts![0]).toEqual({
      functionCall: { id: "x9", name: "get_flow", args: { a: 1 } },
      thoughtSignature: "skip_thought_signature_validator",
    });
  });

  it("collects streamed parts into one message", () => {
    const seen: string[] = [];
    const col = new GeminiCollector({ onText: (d) => seen.push(`t:${d}`), onThinking: (d) => seen.push(`k:${d}`) });
    col.add({ candidates: [{ content: { parts: [{ text: "Let me ", thought: true }] } }] } as never);
    col.add({
      candidates: [{ content: { parts: [{ text: "think", thought: true, thoughtSignature: "S0" }] } }],
    } as never);
    col.add({ candidates: [{ content: { parts: [{ text: "Hello " }] } }] } as never);
    col.add({ candidates: [{ content: { parts: [{ text: "there" }] } }] } as never);
    col.add({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { id: "f1", name: "get_flow", args: { x: 1 } }, thoughtSignature: "S1" },
              { functionCall: { name: "list_lookups", args: {} } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
    } as never);
    const m = col.message("gemini-x");
    expect(seen).toEqual(["k:Let me ", "k:think", "t:Hello ", "t:there"]);
    expect(m.stop_reason).toBe("tool_use");
    expect(m.usage).toEqual({ input_tokens: 10, output_tokens: 8 });
    const blocks = m.content as unknown as Record<string, unknown>[];
    expect(blocks[0]).toEqual({
      type: "thinking",
      thinking: "Let me think",
      signature: "",
      provider_data: { gemini: { thoughtSignature: "S0" } },
    });
    expect(blocks[1]).toEqual({ type: "text", text: "Hello there" });
    expect(blocks[2]).toEqual({
      type: "tool_use",
      id: "f1",
      name: "get_flow",
      input: { x: 1 },
      provider_data: { gemini: { thoughtSignature: "S1" } },
    });
    expect(blocks[3]).toMatchObject({
      type: "tool_use",
      name: "list_lookups",
      provider_data: { gemini: { generatedId: true } },
    });
    // Round trip: what came back goes out again unchanged.
    expect(toGeminiContents([{ role: "assistant", content: m.content } as MessageParam])[0]!.parts![2]).toEqual({
      functionCall: { id: "f1", name: "get_flow", args: { x: 1 } },
      thoughtSignature: "S1",
    });
  });

  it("maps refusals, cut-offs and broken calls", () => {
    const end = (finishReason: string) => {
      const c = new GeminiCollector();
      c.add({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason }] } as never);
      return c;
    };
    expect(end("SAFETY").message("m").stop_reason).toBe("refusal");
    expect(end("MAX_TOKENS").message("m").stop_reason).toBe("max_tokens");
    expect(end("STOP").message("m").stop_reason).toBe("end_turn");
    expect(() => end("MALFORMED_FUNCTION_CALL").message("m")).toThrow(ToolInputParseError);
  });
});

describe("OpenAI translation", () => {
  it("sends reasoning items, calls and outputs as Responses input", () => {
    expect(toOpenAIInput(history)).toEqual([
      { role: "user", content: "Build it" },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" },
      { role: "assistant", content: "Checking." },
      { type: "function_call", call_id: "c1", name: "list_connections", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "list_lookups", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "[]" },
      { type: "function_call_output", call_id: "c2", output: "Error: none" },
      { type: "function_call", call_id: "x9", name: "get_flow", arguments: '{"a":1}' },
      { type: "function_call_output", call_id: "x9", output: "{}" },
    ]);
  });

  it("reads a response back", () => {
    const m = fromOpenAIResponse(
      {
        id: "resp_1",
        output: [
          {
            type: "reasoning",
            id: "rs_2",
            summary: [{ type: "summary_text", text: "Plan" }],
            encrypted_content: "E2",
            status: "completed",
          },
          {
            type: "message",
            id: "m1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
          },
          { type: "function_call", call_id: "call_1", name: "get_flow", arguments: '{"a":2}' },
        ],
        usage: { input_tokens: 7, output_tokens: 3 },
      } as never,
      "gpt-x",
    );
    expect(m.stop_reason).toBe("tool_use");
    expect(m.content).toEqual([
      {
        type: "thinking",
        thinking: "Plan",
        signature: "",
        provider_data: {
          openai: {
            item: {
              type: "reasoning",
              id: "rs_2",
              summary: [{ type: "summary_text", text: "Plan" }],
              encrypted_content: "E2",
            },
          },
        },
      },
      { type: "text", text: "Done." },
      { type: "tool_use", id: "call_1", name: "get_flow", input: { a: 2 } },
    ]);
    expect(() =>
      fromOpenAIResponse(
        { output: [{ type: "function_call", call_id: "c", name: "n", arguments: "{oops" }] } as never,
        "m",
      ),
    ).toThrow(ToolInputParseError);
    expect(
      fromOpenAIResponse({ output: [], incomplete_details: { reason: "max_output_tokens" } } as never, "m").stop_reason,
    ).toBe("max_tokens");
  });
});

describe("Claude translation", () => {
  it("drops other providers' reasoning and extra fields", () => {
    const out = toAnthropicMessages(history) as unknown as { content: Record<string, unknown>[] }[];
    expect(out[1]!.content.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
    expect(out[1]!.content.every((b) => !("provider_data" in b))).toBe(true);
  });
});

describe("choosing a provider", () => {
  it("prefers AI_PROVIDER, else the first key in the order Gemini, Claude, GPT", () => {
    expect(configuredProvider({})).toBeNull();
    expect(configuredProvider({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(configuredProvider({ OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" })).toBe("anthropic");
    expect(configuredProvider({ AI_PROVIDER: "GPT", GEMINI_API_KEY: "g" })).toBe("openai");
    expect(configuredProvider({ AI_PROVIDER: "claude" })).toBe("anthropic");
    expect(() => configuredProvider({ AI_PROVIDER: "llama" })).toThrow(/not known/);
    expect(modelFromEnv({ AI_PROVIDER: "openai" })).toBeNull();
    expect(aiSetupHint({ AI_PROVIDER: "openai" })).toContain("OPENAI_API_KEY");
    expect(aiSetupHint({})).toContain("GEMINI_API_KEY");
    expect(modelFromEnv({ GOOGLE_API_KEY: "g", GEMINI_MODEL: "gemini-test" })).toMatchObject({ provider: "gemini" });
  });
});

// ── the SDKs against a local server ──────────────────────────────────────

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(
  handler: (req: { url: string; body: Record<string, unknown> }) => { status?: number; sse?: string[]; json?: unknown },
) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const r = { url: req.url ?? "", body: raw ? JSON.parse(raw) : {} };
      seen.push(r);
      const out = handler(r);
      if (out.sse) {
        res.writeHead(out.status ?? 200, { "content-type": "text/event-stream" });
        for (const e of out.sse) res.write(e);
        res.end();
      } else {
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json ?? {}));
      }
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}

const req: TurnRequest = {
  system: [{ type: "text", text: "You build integrations." }],
  tools: [
    {
      name: "get_flow",
      description: "Get the flow",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  ],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("GeminiModel over HTTP", () => {
  it("streams a turn and sends system, tools and thinking settings", async () => {
    const chunk = (v: unknown) => `data: ${JSON.stringify(v)}\r\n\r\n`;
    const { base, seen } = await serve(() => ({
      sse: [
        chunk({ candidates: [{ content: { role: "model", parts: [{ text: "Sure", thought: false }] } }] }),
        chunk({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { id: "g1", name: "get_flow", args: {} }, thoughtSignature: "SIG" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
        }),
      ],
    }));
    const text: string[] = [];
    const m = await new GeminiModel({ apiKey: "g-key", model: "gemini-test", baseURL: base, effort: "medium" }).turn(
      req,
      { onText: (d) => text.push(d) },
    );
    expect(seen[0]!.url).toContain("/models/gemini-test:streamGenerateContent");
    const body = seen[0]!.body as {
      systemInstruction: unknown;
      tools: { functionDeclarations: Record<string, unknown>[] }[];
      generationConfig: { thinkingConfig: unknown };
    };
    expect(JSON.stringify(body.systemInstruction)).toContain("You build integrations.");
    expect(body.tools[0]!.functionDeclarations[0]).toMatchObject({
      name: "get_flow",
      parametersJsonSchema: { type: "object" },
    });
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "MEDIUM", includeThoughts: true });
    expect(text).toEqual(["Sure"]);
    expect(m.stop_reason).toBe("tool_use");
    expect(m.content[1]).toMatchObject({
      type: "tool_use",
      id: "g1",
      provider_data: { gemini: { thoughtSignature: "SIG" } },
    });
  });

  it("turns HTTP errors into provider errors", async () => {
    const { base } = await serve(() => ({
      status: 403,
      json: { error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" } },
    }));
    const err = await new GeminiModel({ apiKey: "bad", baseURL: base }).turn(req).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject({ kind: "auth", provider: "gemini", status: 403 });
  });

  it("recognises Google's bad-key answer (400 API_KEY_INVALID) as a key problem", async () => {
    const { base } = await serve(() => ({
      status: 400,
      json: {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
        },
      },
    }));
    const err = await new GeminiModel({ apiKey: "bad", baseURL: base }).turn(req).catch((e) => e);
    expect(err).toMatchObject({ kind: "auth", provider: "gemini", status: 400 });
  });
});

describe("OpenAIModel over HTTP", () => {
  it("streams a turn through the Responses API without storing it", async () => {
    let n = 0;
    const ev = (type: string, data: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: n++, ...data })}\n\n`;
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Plan" }],
      encrypted_content: "ENC",
    };
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hi there", annotations: [] }],
    };
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "get_flow",
      arguments: "{}",
      status: "completed",
    };
    const base0 = {
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt-test",
      status: "in_progress",
      output: [] as unknown[],
      tools: [],
      parallel_tool_calls: true,
    };
    const { base, seen } = await serve(() => ({
      sse: [
        ev("response.created", { response: base0 }),
        ev("response.output_item.added", {
          output_index: 0,
          item: { ...reasoning, summary: [], encrypted_content: null },
        }),
        ev("response.reasoning_summary_part.added", {
          output_index: 0,
          item_id: "rs_1",
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }),
        ev("response.reasoning_summary_text.delta", {
          output_index: 0,
          item_id: "rs_1",
          summary_index: 0,
          delta: "Plan",
        }),
        ev("response.reasoning_summary_text.done", {
          output_index: 0,
          item_id: "rs_1",
          summary_index: 0,
          text: "Plan",
        }),
        ev("response.reasoning_summary_part.done", {
          output_index: 0,
          item_id: "rs_1",
          summary_index: 0,
          part: { type: "summary_text", text: "Plan" },
        }),
        ev("response.output_item.done", { output_index: 0, item: reasoning }),
        ev("response.output_item.added", { output_index: 1, item: { ...message, status: "in_progress", content: [] } }),
        ev("response.content_part.added", {
          output_index: 1,
          item_id: "msg_1",
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
        ev("response.output_text.delta", {
          output_index: 1,
          item_id: "msg_1",
          content_index: 0,
          delta: "Hi ",
          logprobs: [],
        }),
        ev("response.output_text.delta", {
          output_index: 1,
          item_id: "msg_1",
          content_index: 0,
          delta: "there",
          logprobs: [],
        }),
        ev("response.output_text.done", {
          output_index: 1,
          item_id: "msg_1",
          content_index: 0,
          text: "Hi there",
          logprobs: [],
        }),
        ev("response.content_part.done", {
          output_index: 1,
          item_id: "msg_1",
          content_index: 0,
          part: { type: "output_text", text: "Hi there", annotations: [] },
        }),
        ev("response.output_item.done", { output_index: 1, item: message }),
        ev("response.output_item.added", { output_index: 2, item: { ...call, arguments: "", status: "in_progress" } }),
        ev("response.function_call_arguments.delta", { output_index: 2, item_id: "fc_1", delta: "{}" }),
        ev("response.function_call_arguments.done", { output_index: 2, item_id: "fc_1", arguments: "{}" }),
        ev("response.output_item.done", { output_index: 2, item: call }),
        ev("response.completed", {
          response: {
            ...base0,
            status: "completed",
            output: [reasoning, message, call],
            usage: { input_tokens: 20, output_tokens: 9, total_tokens: 29 },
          },
        }),
      ],
    }));
    const got: string[] = [];
    const m = await new OpenAIModel({ apiKey: "o-key", model: "gpt-test", baseURL: base, effort: "xhigh" }).turn(req, {
      onText: (d) => got.push(`t:${d}`),
      onThinking: (d) => got.push(`k:${d}`),
    });
    const body = seen[0]!.body as Record<string, unknown>;
    expect(seen[0]!.url).toBe("/responses");
    expect(body).toMatchObject({
      model: "gpt-test",
      instructions: "You build integrations.",
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "xhigh" },
      stream: true,
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "get_flow",
        description: "Get the flow",
        parameters: req.tools[0]!.input_schema,
        strict: false,
      },
    ]);
    expect(got).toEqual(["k:Plan", "t:Hi ", "t:there"]);
    expect(m.stop_reason).toBe("tool_use");
    expect(m.usage).toEqual({ input_tokens: 20, output_tokens: 9 });
    expect(m.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
  });

  it("turns HTTP errors into provider errors", async () => {
    const { base } = await serve(() => ({
      status: 429,
      json: { error: { message: "Rate limit", type: "rate_limit" } },
    }));
    const err = await new OpenAIModel({ apiKey: "k", baseURL: base }).turn(req).catch((e) => e);
    expect(err).toMatchObject({ kind: "rate_limit", provider: "openai", status: 429 });
  });
});
