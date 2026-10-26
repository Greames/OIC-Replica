import type Anthropic from "@anthropic-ai/sdk";
import {
  type Actor,
  appendAiMessage,
  claimAiSession,
  type Db,
  emitEvent,
  getAiSession,
  getIntegration,
  type PendingQuestion,
  projects,
  releaseAiSession,
} from "@oicr/db";
import { eq } from "drizzle-orm";
import type { Message, MessageParam, ModelClient } from "./model.js";
import { ModelError, ToolInputParseError } from "./model.js";
import { contextPreamble, systemPrompt } from "./prompt.js";
import { PROVIDERS } from "./providers/index.js";
import { type AiEvent, ASK_USER, parseAskUser, runTool, TOOLS, type ToolContext } from "./tools.js";

export interface TurnOptions {
  db: Db;
  actor: Actor;
  sessionId: string;
  /** What the person typed, or the answer to a pending question. */
  text: string;
  model: ModelClient;
  emit: (event: AiEvent) => void;
  signal?: AbortSignal;
  /** Model calls allowed for one message from the person. */
  maxIterations?: number;
  /** Total tokens one conversation may use. */
  tokenLimit?: number;
}

type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/**
 * Runs one turn of the AI builder: appends the person's message, then calls
 * the model and its tools until it ends its turn, asks a question (pauses),
 * or hits a limit. Every message is persisted as it happens, append-only.
 */
export async function runTurn(opts: TurnOptions): Promise<"idle" | "waiting" | "error"> {
  const { db, actor, sessionId, model, emit } = opts;
  const maxIterations = opts.maxIterations ?? Number(process.env.AI_MAX_ITERATIONS ?? 12);
  const tokenLimit = opts.tokenLimit ?? Number(process.env.AI_SESSION_TOKEN_LIMIT ?? 3_000_000);

  let session = await claimAiSession(db, actor, sessionId);
  const finish = async (
    status: "idle" | "waiting" | "error",
    extra: { pending?: PendingQuestion; error?: string } = {},
  ) => {
    await releaseAiSession(db, sessionId, { status, pending: extra.pending ?? null, lastError: extra.error ?? null });
    if (extra.error) emit({ type: "error", message: extra.error });
    emit({ type: "done", status });
    return status;
  };

  try {
    const { messages: stored } = await getAiSession(db, actor, sessionId);
    const history: MessageParam[] = stored.map((m) => ({ role: m.role, content: m.content }) as MessageParam);

    // The person's message: an answer to a pending question, or new text.
    let userContent: Anthropic.Beta.BetaContentBlockParam[];
    if (session.pending) {
      userContent = [
        ...(session.pending.otherResults as ToolResult[]),
        { type: "tool_result", tool_use_id: session.pending.toolUseId, content: opts.text },
      ];
    } else if (history.length === 0) {
      const [project] = await db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, session.projectId));
      const integration = session.integrationId ? await getIntegration(db, actor, session.integrationId) : null;
      const preamble = contextPreamble({
        projectName: project?.name ?? "",
        integration: integration && { name: integration.name, style: integration.style, status: integration.status },
        today: new Date().toISOString().slice(0, 10),
      });
      userContent = [
        { type: "text", text: preamble },
        { type: "text", text: opts.text },
      ];
    } else {
      userContent = [{ type: "text", text: opts.text }];
    }
    history.push({ role: "user", content: userContent } as MessageParam);
    await appendAiMessage(db, sessionId, { role: "user", content: userContent as unknown[] });

    const ctx: ToolContext = { db, actor, session, failedProposals: 0, emit };
    let parseRetries = 0;

    for (let i = 0; i < maxIterations; i++) {
      const fresh = await getAiSession(db, actor, sessionId);
      session = fresh.session;
      ctx.session = session;
      if (session.inputTokens + session.outputTokens > tokenLimit) {
        return await finish("error", {
          error: "This conversation reached its size limit. Start a new one to continue.",
        });
      }

      let message: Message;
      try {
        message = await model.turn(
          { system: systemPrompt(), tools: TOOLS, messages: history },
          {
            onText: (delta) => emit({ type: "text", delta }),
            onThinking: (delta) => emit({ type: "thinking", delta }),
          },
          opts.signal,
        );
        parseRetries = 0;
      } catch (e) {
        if (e instanceof ToolInputParseError && parseRetries++ < 2) {
          i--;
          continue; // re-issue the same turn; nothing was persisted
        }
        throw e;
      }

      // Persist exactly what came back: thinking blocks stay valid only on an unchanged history.
      history.push({ role: "assistant", content: message.content } as MessageParam);
      await appendAiMessage(db, sessionId, {
        role: "assistant",
        content: message.content as unknown[],
        model: message.model,
        stopReason: message.stop_reason,
        usage: message.usage,
      });

      if (message.stop_reason === "refusal") {
        return await finish("error", {
          error: "The AI declined this request. Try rephrasing what the integration should do.",
        });
      }
      if (message.stop_reason === "pause_turn") continue;

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) return await finish("idle");
      if (message.stop_reason === "max_tokens") {
        return await finish("error", {
          error: "The answer was cut off. Ask for a smaller change, or send your message again.",
        });
      }

      // Run every tool call of this turn; results go back together in one message.
      const results: ToolResult[] = [];
      let pending: PendingQuestion | undefined;
      for (const use of toolUses) {
        if (use.name === ASK_USER) {
          const q = parseAskUser(use.input);
          if (q.success && !pending) {
            pending = { toolUseId: use.id, question: q.data.question, choices: q.data.choices, otherResults: [] };
            emit({ type: "question", question: q.data.question, choices: q.data.choices });
          } else {
            results.push({
              type: "tool_result",
              tool_use_id: use.id,
              is_error: true,
              content: "Ask one question at a time, with a question and choices.",
            });
          }
          continue;
        }
        emit({ type: "tool", name: use.name, status: "start" });
        let outcome: Awaited<ReturnType<typeof runTool>>;
        try {
          outcome = await runTool(use.name, use.input, ctx);
        } catch (e) {
          outcome = { content: `The tool failed: ${(e as Error).message}`, isError: true };
        }
        emit({
          type: "tool",
          name: use.name,
          status: outcome.isError ? "error" : "done",
          detail: outcome.isError ? outcome.content.split("\n")[0] : undefined,
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }

      if (pending) {
        pending.otherResults = results;
        await emitEvent(db, {
          orgId: actor.orgId,
          type: "ai.question",
          subjectType: "ai_session",
          subjectId: sessionId,
          summary: `The AI builder is waiting for your answer: ${pending.question}`,
          path: `/ai/${sessionId}`,
          data: { choices: pending.choices },
        });
        return await finish("waiting", { pending });
      }
      history.push({ role: "user", content: results } as MessageParam);
      await appendAiMessage(db, sessionId, { role: "user", content: results });
    }
    return await finish("error", {
      error: "The AI took too many steps on this message. Send it again, or ask for a smaller change.",
    });
  } catch (e) {
    const p = e instanceof ModelError ? PROVIDERS[e.provider] : null;
    const message =
      e instanceof ModelError && e.kind === "auth"
        ? `${p!.name} rejected the API key. Check ${p!.keyEnv[0]}.`
        : e instanceof ModelError && e.kind === "rate_limit"
          ? `${p!.name} is busy (rate limited). Try again in a minute.`
          : e instanceof ModelError
            ? `${p!.name} returned an error${e.status ? ` (${e.status})` : ""}. Try again.`
            : `Something went wrong: ${(e as Error).message}`;
    return await finish("error", { error: message });
  }
}
