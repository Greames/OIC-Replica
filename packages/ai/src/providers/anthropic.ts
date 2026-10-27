import Anthropic from "@anthropic-ai/sdk";
import {
  type Effort,
  envEffort,
  type Message,
  type MessageParam,
  type ModelClient,
  modelErrorFromStatus,
  providerData,
  type StreamHandlers,
  ToolInputParseError,
  type TurnRequest,
} from "../model.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Claude through the Messages API (beta namespace for server-side fallback).
 * - adaptive thinking (always on for this model), effort "high": building a
 *   correct integration is intelligence-sensitive work
 * - refused requests are retried on a fallback model inside the same call
 * - system prompt + tools are cached; the rolling conversation tail is cached
 *   with top-level automatic caching
 */
export class AnthropicModel implements ModelClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;
  private effort: Effort;

  constructor(opts: { model?: string; apiKey?: string; effort?: Effort; baseURL?: string } = {}) {
    this.model = opts.model || process.env.ANTHROPIC_MODEL || process.env.AI_MODEL || ANTHROPIC_DEFAULT_MODEL;
    this.effort = opts.effort || envEffort();
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async turn(req: TurnRequest, handlers: StreamHandlers = {}, signal?: AbortSignal): Promise<Message> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: this.effort },
        cache_control: { type: "ephemeral" },
        system: req.system,
        tools: req.tools,
        messages: toAnthropicMessages(req.messages),
      },
      { signal },
    );
    if (handlers.onText) stream.on("text", (d) => handlers.onText?.(d));
    if (handlers.onThinking) stream.on("thinking", (d) => handlers.onThinking?.(d));
    try {
      return await stream.finalMessage();
    } catch (err) {
      // API errors (rate limits, auth, 5xx) are rethrown as-is; only an
      // unparseable streamed tool input is turned into a retryable error.
      if (err instanceof Anthropic.APIError) throw modelErrorFromStatus("anthropic", err.status, err.message);
      if (err instanceof Error && /json/i.test(err.message)) throw new ToolInputParseError(err.message);
      throw err;
    }
  }
}

/**
 * Claude only accepts its own thinking blocks, and no unknown fields. Blocks
 * written by another provider (after switching providers mid-conversation)
 * are dropped or cleaned.
 */
export function toAnthropicMessages(messages: MessageParam[]): MessageParam[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const content = (m.content as { type: string }[])
      .filter((b) => !((b.type === "thinking" || b.type === "redacted_thinking") && providerData(b)))
      .map((b) => {
        if (!providerData(b)) return b;
        const { provider_data: _p, ...rest } = b as typeof b & { provider_data?: unknown };
        return rest;
      });
    return { ...m, content } as MessageParam;
  });
}
