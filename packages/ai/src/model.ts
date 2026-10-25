import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

export type Message = Anthropic.Beta.BetaMessage;
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Tool = Anthropic.Beta.BetaTool;
export type TextBlockParam = Anthropic.Beta.BetaTextBlockParam;

export interface TurnRequest {
  system: TextBlockParam[];
  tools: Tool[];
  messages: MessageParam[];
}

export interface StreamHandlers {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
}

/** One model call. Implementations stream deltas and resolve with the full message. */
export interface ModelClient {
  readonly model: string;
  turn(req: TurnRequest, handlers?: StreamHandlers, signal?: AbortSignal): Promise<Message>;
}

/** Thrown when a streamed tool input could not be parsed at all; the turn can be re-issued. */
export class ToolInputParseError extends Error {}

export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Claude through the Messages API (beta namespace for server-side fallback).
 * - adaptive thinking (always on for this model), effort "high": building a
 *   correct integration is intelligence-sensitive work
 * - refused requests are retried on a fallback model inside the same call
 * - system prompt + tools are cached; the rolling conversation tail is cached
 *   with top-level automatic caching
 */
export class AnthropicModel implements ModelClient {
  readonly model: string;
  private client: Anthropic;
  private effort: "low" | "medium" | "high" | "xhigh" | "max";

  constructor(opts: { model?: string; apiKey?: string; effort?: AnthropicModel["effort"] } = {}) {
    this.model = opts.model || process.env.AI_MODEL || DEFAULT_MODEL;
    this.effort = opts.effort || (process.env.AI_EFFORT as AnthropicModel["effort"]) || "high";
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
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
        messages: req.messages,
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
      if (err instanceof Anthropic.APIError) throw err;
      if (err instanceof Error && /json/i.test(err.message)) throw new ToolInputParseError(err.message);
      throw err;
    }
  }
}

/**
 * Plays back recorded assistant turns in order. For tests and offline e2e
 * runs (AI_PROVIDER=scripted, AI_SCRIPT_FILE=...). Text is "streamed" in chunks.
 */
export class ScriptedModel implements ModelClient {
  readonly model = "scripted";
  private turns: Array<Message["content"]>;
  readonly requests: TurnRequest[] = [];

  constructor(turns: Array<Message["content"] | unknown[]>) {
    this.turns = turns as Array<Message["content"]>;
  }

  static fromFile(path: string): ScriptedModel {
    return new ScriptedModel(JSON.parse(readFileSync(path, "utf8")));
  }

  async turn(req: TurnRequest, handlers: StreamHandlers = {}): Promise<Message> {
    this.requests.push(structuredClone(req));
    const content = this.turns.shift();
    if (!content) throw new Error("ScriptedModel: no more scripted turns");
    for (const block of content) {
      if (block.type === "text") for (const chunk of block.text.match(/.{1,24}/gs) ?? []) handlers.onText?.(chunk);
      if (block.type === "thinking") handlers.onThinking?.(block.thinking);
    }
    const hasTool = content.some((b) => b.type === "tool_use");
    return {
      id: `msg_scripted_${this.requests.length}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content,
      stop_reason: hasTool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    } as unknown as Message;
  }
}

/** The configured model: Claude, or a script for offline runs. Null when not configured. */
export function modelFromEnv(): ModelClient | null {
  if (process.env.AI_PROVIDER === "scripted") {
    const file = process.env.AI_SCRIPT_FILE;
    if (!file) throw new Error("AI_PROVIDER=scripted needs AI_SCRIPT_FILE");
    return ScriptedModel.fromFile(file);
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return new AnthropicModel();
  return null;
}
