import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { Response, ResponseInputItem } from "openai/resources/responses/responses";
import {
  type Effort,
  envEffort,
  type Message,
  type MessageParam,
  type ModelClient,
  modelErrorFromStatus,
  providerData,
  type StreamHandlers,
  systemText,
  ToolInputParseError,
  type TurnRequest,
  toolResultText,
} from "../model.js";

export const OPENAI_DEFAULT_MODEL = "gpt-6-astra";

type Block = Record<string, unknown> & { type: string };

/**
 * The conversation as Responses API input items. Nothing is stored at
 * OpenAI (store: false), so reasoning items travel back with their
 * encrypted content, in front of the calls they led to.
 */
export function toOpenAIInput(messages: MessageParam[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const m of messages) {
    const blocks: Block[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as Block[]);
    let text: string[] = [];
    const flush = () => {
      if (text.length) out.push({ role: m.role === "assistant" ? "assistant" : "user", content: text.join("\n\n") });
      text = [];
    };
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text) text.push(b.text);
      } else if (b.type === "thinking") {
        const item = providerData(b)?.openai?.item;
        if (item) {
          flush();
          out.push(item as unknown as ResponseInputItem);
        }
      } else if (b.type === "tool_use") {
        flush();
        out.push({
          type: "function_call",
          call_id: String(b.id),
          name: String(b.name),
          arguments: JSON.stringify(b.input ?? {}),
        });
      } else if (b.type === "tool_result") {
        flush();
        const t = toolResultText(b.content);
        out.push({
          type: "function_call_output",
          call_id: String(b.tool_use_id),
          output: b.is_error ? `Error: ${t}` : t,
        });
      }
    }
    flush();
  }
  return out;
}

/** A finished response as one canonical message. */
export function fromOpenAIResponse(r: Response, model: string): Message {
  const content: Block[] = [];
  let refused = false;
  for (const item of r.output) {
    if (item.type === "reasoning") {
      const summary = item.summary.map((s) => s.text).join("\n\n");
      const { status: _s, ...keep } = item;
      content.push({
        type: "thinking",
        thinking: summary,
        signature: "",
        provider_data: { openai: { item: keep as Record<string, unknown> } },
      });
    } else if (item.type === "message") {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text });
        if (c.type === "refusal") {
          refused = true;
          content.push({ type: "text", text: c.refusal });
        }
      }
    } else if (item.type === "function_call") {
      let input: unknown;
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch (e) {
        throw new ToolInputParseError(`OpenAI produced invalid tool arguments: ${(e as Error).message}`);
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    }
  }
  const reason = r.incomplete_details?.reason;
  const stop =
    refused || reason === "content_filter"
      ? "refusal"
      : content.some((b) => b.type === "tool_use")
        ? "tool_use"
        : reason === "max_output_tokens"
          ? "max_tokens"
          : "end_turn";
  return {
    id: r.id || `msg_openai_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 },
  } as unknown as Message;
}

/** GPT through the Responses API, streamed, with reasoning at the configured effort. */
export class OpenAIModel implements ModelClient {
  readonly provider = "openai" as const;
  readonly model: string;
  private client: OpenAI;
  private effort: Effort;

  constructor(opts: { model?: string; apiKey?: string; effort?: Effort; baseURL?: string } = {}) {
    this.model = opts.model || process.env.OPENAI_MODEL || process.env.AI_MODEL || OPENAI_DEFAULT_MODEL;
    this.effort = opts.effort || envEffort();
    this.client = new OpenAI({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async turn(req: TurnRequest, handlers: StreamHandlers = {}, signal?: AbortSignal): Promise<Message> {
    let response: Response;
    try {
      const stream = this.client.responses.stream(
        {
          model: this.model,
          instructions: systemText(req.system),
          input: toOpenAIInput(req.messages),
          tools: req.tools.map((t) => ({
            type: "function" as const,
            name: t.name,
            description: t.description ?? null,
            parameters: t.input_schema as Record<string, unknown>,
            strict: false,
          })),
          reasoning: { effort: this.effort, summary: "auto" },
          store: false,
          include: ["reasoning.encrypted_content"],
          max_output_tokens: 64000,
        },
        { signal },
      );
      stream.on("response.output_text.delta", (e) => handlers.onText?.(e.delta));
      stream.on("response.reasoning_summary_text.delta", (e) => handlers.onThinking?.(e.delta));
      response = await stream.finalResponse();
    } catch (err) {
      if (err instanceof OpenAI.APIError) throw modelErrorFromStatus("openai", err.status, err.message);
      throw err;
    }
    return fromOpenAIResponse(response, this.model);
  }
}
