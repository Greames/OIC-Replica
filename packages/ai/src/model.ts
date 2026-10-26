import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";

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
  /** Which service runs it; unset for scripted models. */
  readonly provider?: ProviderId;
  turn(req: TurnRequest, handlers?: StreamHandlers, signal?: AbortSignal): Promise<Message>;
}

/** Thrown when a streamed tool input could not be parsed at all; the turn can be re-issued. */
export class ToolInputParseError extends Error {}

export type ProviderId = "gemini" | "anthropic" | "openai";

/** A provider error, so the loop can explain it the same way for every provider. */
export class ModelError extends Error {
  constructor(
    readonly kind: "auth" | "rate_limit" | "api",
    readonly provider: ProviderId,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export function modelErrorFromStatus(provider: ProviderId, status: number | undefined, message: string): ModelError {
  const kind = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : "api";
  return new ModelError(kind, provider, status, message);
}

/**
 * Data a provider needs back on a later turn (Gemini thought signatures,
 * OpenAI reasoning items). Stored on the block; other providers ignore it.
 */
export interface ProviderData {
  gemini?: { thoughtSignature?: string; generatedId?: boolean };
  openai?: { item?: Record<string, unknown> };
}

/** Reads a block's provider data, whatever the block type. */
export const providerData = (block: unknown): ProviderData | undefined =>
  (block as { provider_data?: ProviderData } | null)?.provider_data;

/** The system prompt as one string, for providers without system blocks. */
export const systemText = (system: TextBlockParam[]) => system.map((b) => b.text).join("\n\n");

/** The text of a tool result's content (string or text blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("\n");
  return "";
}

/** Normalised "effort" for all providers (AI_EFFORT). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const envEffort = (): Effort => (process.env.AI_EFFORT as Effort) || "high";

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
