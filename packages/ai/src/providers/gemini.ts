import { randomUUID } from "node:crypto";
import {
  ApiError,
  type Content,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
  ThinkingLevel,
} from "@google/genai";
import {
  type Effort,
  envEffort,
  type Message,
  type MessageParam,
  type ModelClient,
  ModelError,
  modelErrorFromStatus,
  type ProviderData,
  providerData,
  type StreamHandlers,
  systemText,
  ToolInputParseError,
  type TurnRequest,
  toolResultText,
} from "../model.js";

export const GEMINI_DEFAULT_MODEL = "gemini-4-argon";

/**
 * Gemini rejects a replayed function call without the signature it was
 * issued with. Calls made by another provider (or recorded scripts) carry
 * none, so they get the documented placeholder that skips the check.
 */
const SKIP_SIGNATURE = "skip_thought_signature_validator";

const LEVEL: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.HIGH,
  max: ThinkingLevel.HIGH,
};

type Block = Record<string, unknown> & { type: string };

/** The conversation in Gemini's shape: user/model turns of parts. */
export function toGeminiContents(messages: MessageParam[]): Content[] {
  const names = new Map<string, { name: string; sendId: boolean }>();
  const out: Content[] = [];
  for (const m of messages) {
    const blocks: Block[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as unknown as Block[]);
    const parts: Part[] = [];
    for (const b of blocks) {
      const g = providerData(b)?.gemini;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text || g?.thoughtSignature)
          parts.push({ text: b.text, ...(g?.thoughtSignature ? { thoughtSignature: g.thoughtSignature } : {}) });
      } else if (b.type === "thinking") {
        // Only Gemini's own thoughts go back; others' reasoning is not portable.
        if (g)
          parts.push({
            text: String(b.thinking ?? ""),
            thought: true,
            ...(g.thoughtSignature ? { thoughtSignature: g.thoughtSignature } : {}),
          });
      } else if (b.type === "tool_use") {
        const id = String(b.id);
        const sendId = !g?.generatedId;
        names.set(id, { name: String(b.name), sendId });
        parts.push({
          functionCall: {
            ...(sendId ? { id } : {}),
            name: String(b.name),
            args: (b.input ?? {}) as Record<string, unknown>,
          },
          thoughtSignature: g ? g.thoughtSignature : SKIP_SIGNATURE,
        });
      } else if (b.type === "tool_result") {
        const id = String(b.tool_use_id);
        const call = names.get(id);
        const text = toolResultText(b.content);
        parts.push({
          functionResponse: {
            ...(call?.sendId === false ? {} : { id }),
            name: call?.name ?? "unknown",
            response: b.is_error ? { error: text } : { output: text },
          },
        });
      }
    }
    if (parts.length === 0) continue;
    const role = m.role === "assistant" ? "model" : "user";
    // A signature-less part must not follow the first function call of a turn; drop extra placeholders.
    let firstCall = true;
    for (const p of parts) {
      if (p.functionCall) {
        if (!firstCall && p.thoughtSignature === SKIP_SIGNATURE) delete p.thoughtSignature;
        firstCall = false;
      }
      if (p.thoughtSignature === undefined) delete p.thoughtSignature;
    }
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts = [...(last.parts ?? []), ...parts];
    else out.push({ role, parts });
  }
  return out;
}

const REFUSED = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "LANGUAGE",
]);

/** Collects streamed chunks into one canonical message. */
export class GeminiCollector {
  readonly content: Block[] = [];
  finishReason: string | undefined;
  blocked: string | undefined;
  usage = { input_tokens: 0, output_tokens: 0 };

  constructor(private handlers: StreamHandlers = {}) {}

  add(chunk: GenerateContentResponse): void {
    if (chunk.promptFeedback?.blockReason) this.blocked = String(chunk.promptFeedback.blockReason);
    const u = chunk.usageMetadata;
    if (u)
      this.usage = {
        input_tokens: u.promptTokenCount ?? 0,
        output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      };
    const cand = chunk.candidates?.[0];
    if (cand?.finishReason) this.finishReason = String(cand.finishReason);
    for (const part of cand?.content?.parts ?? []) this.part(part);
  }

  private part(part: Part): void {
    const sig = part.thoughtSignature;
    const last = this.content[this.content.length - 1];
    const withSig = (pd: ProviderData | undefined): ProviderData => ({
      gemini: { ...pd?.gemini, ...(sig ? { thoughtSignature: sig } : {}) },
    });
    if (part.functionCall) {
      const fc = part.functionCall;
      this.content.push({
        type: "tool_use",
        id: fc.id || `call_${randomUUID().slice(0, 12)}`,
        name: fc.name ?? "",
        input: fc.args ?? {},
        provider_data: {
          gemini: { ...(sig ? { thoughtSignature: sig } : {}), ...(fc.id ? {} : { generatedId: true }) },
        },
      });
      return;
    }
    if (typeof part.text === "string") {
      if (part.thought) {
        if (part.text) this.handlers.onThinking?.(part.text);
        if (last?.type === "thinking" && !providerData(last)?.gemini?.thoughtSignature) {
          last.thinking = `${last.thinking}${part.text}`;
          last.provider_data = withSig(providerData(last));
        } else
          this.content.push({
            type: "thinking",
            thinking: part.text,
            signature: "",
            provider_data: withSig(undefined),
          });
        return;
      }
      if (part.text) this.handlers.onText?.(part.text);
      if (last?.type === "text" && !providerData(last)?.gemini?.thoughtSignature) {
        last.text = `${last.text}${part.text}`;
        if (sig) last.provider_data = withSig(providerData(last));
      } else if (part.text || sig) {
        this.content.push({ type: "text", text: part.text, ...(sig ? { provider_data: withSig(undefined) } : {}) });
      }
    }
  }

  message(model: string): Message {
    if (this.finishReason === "MALFORMED_FUNCTION_CALL" || this.finishReason === "UNEXPECTED_TOOL_CALL")
      throw new ToolInputParseError(`Gemini produced an invalid tool call (${this.finishReason}).`);
    const hasTool = this.content.some((b) => b.type === "tool_use");
    const stop =
      this.blocked || (this.finishReason && REFUSED.has(this.finishReason))
        ? "refusal"
        : hasTool
          ? "tool_use"
          : this.finishReason === "MAX_TOKENS"
            ? "max_tokens"
            : "end_turn";
    return {
      id: `msg_gemini_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: this.content,
      stop_reason: stop,
      stop_sequence: null,
      usage: this.usage,
    } as unknown as Message;
  }
}

/**
 * Gemini through the Gemini API (@google/genai), streamed, with thinking at
 * the configured level. Thought signatures are kept on the blocks and sent
 * back, as Gemini requires for function calling.
 */
export class GeminiModel implements ModelClient {
  readonly provider = "gemini" as const;
  readonly model: string;
  private client: GoogleGenAI;
  private effort: Effort;

  constructor(opts: { model?: string; apiKey?: string; effort?: Effort; baseURL?: string } = {}) {
    this.model = opts.model || process.env.GEMINI_MODEL || process.env.AI_MODEL || GEMINI_DEFAULT_MODEL;
    this.effort = opts.effort || envEffort();
    const apiKey = opts.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const baseUrl = opts.baseURL || process.env.GEMINI_BASE_URL;
    this.client = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  }

  async turn(req: TurnRequest, handlers: StreamHandlers = {}, signal?: AbortSignal): Promise<Message> {
    const collector = new GeminiCollector(handlers);
    try {
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents: toGeminiContents(req.messages),
        config: {
          systemInstruction: systemText(req.system),
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.input_schema,
              })),
            },
          ],
          thinkingConfig: { thinkingLevel: LEVEL[this.effort], includeThoughts: true },
          maxOutputTokens: 64000,
          abortSignal: signal,
        },
      });
      for await (const chunk of stream) collector.add(chunk);
    } catch (err) {
      if (err instanceof ApiError) {
        // A bad key comes back as 400 INVALID_ARGUMENT with reason API_KEY_INVALID.
        if (/API_KEY_INVALID|API key not valid/.test(err.message))
          throw new ModelError("auth", "gemini", err.status, err.message);
        throw modelErrorFromStatus("gemini", err.status, err.message);
      }
      if (err instanceof ModelError || err instanceof ToolInputParseError) throw err;
      throw err;
    }
    return collector.message(this.model);
  }
}
