import type Anthropic from "@anthropic-ai/sdk";
import {
  type Actor,
  AUTO_APPROVE_AT,
  assertCan,
  type Db,
  loadSemanticGraph,
  recordProposal,
  type SemanticProposal,
} from "@oicr/db";
import { ATTR, retry, withSpan } from "@oicr/platform";
import {
  BINDING_PROPOSAL_SCHEMA,
  bindingPrompt,
  type CheckedProposal,
  checkProposal,
  describeSample,
  ObjectName,
  type Sample,
  type SemanticGraph,
  SystemId,
} from "@oicr/semantic";
import { type MessageParam, type ModelClient, ModelError, type Tool, ToolInputParseError } from "./model.js";
import { PROVIDERS } from "./providers/index.js";

// AI binding discovery: the model reads a schema sample and proposes which
// catalog attribute each field holds. Proposals are checked against the
// catalog before they are stored; people review whatever the policy does not
// approve. Runs never call a model: approved bindings compile into plans.

const SUBMIT = "submit_bindings";

const SUBMIT_TOOL: Tool = {
  name: SUBMIT,
  description: "Submit the entity and the field bindings for the object. Call it exactly once.",
  input_schema: BINDING_PROPOSAL_SCHEMA as unknown as Tool["input_schema"],
};

/** A model answer that could not be used even after asking it to correct itself. */
export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalError";
  }
}

export interface ProposeRequest {
  system: string;
  object: string;
  sample: Sample;
  entityHint?: string;
  signal?: AbortSignal;
}

const transient = (e: unknown) =>
  e instanceof ToolInputParseError ||
  (e instanceof ModelError && (e.kind === "rate_limit" || (e.status !== undefined && e.status >= 500)));

/**
 * Asks the model for bindings and checks them. One correction round: when the
 * answer fails the checks, the model is told why and answers again.
 */
export function proposeBindings(
  model: ModelClient,
  graph: SemanticGraph,
  req: ProposeRequest,
): Promise<CheckedProposal> {
  return withSpan(
    "ai propose_bindings",
    {
      [ATTR.aiProvider]: model.provider ?? "scripted",
      [ATTR.aiModel]: model.model,
      "oicr.semantic_system": req.system,
      "oicr.semantic_object": req.object,
      "oicr.semantic_fields": req.sample.fields.length,
    },
    async (span) => {
      const prompt = bindingPrompt(graph, req);
      const messages: MessageParam[] = [{ role: "user", content: prompt.user }];
      // A usable answer whose invalid bindings were dropped: kept if the correction fails.
      let fallback: CheckedProposal | undefined;
      const done = (p: CheckedProposal, round: number) => {
        span.setAttributes({
          "oicr.semantic_entity": p.entity,
          "oicr.semantic_bindings": p.bindings.length,
          "oicr.semantic_dropped": p.dropped.length,
          "oicr.ai_rounds": round,
        });
        return p;
      };
      for (let round = 1; round <= 2; round++) {
        const message = await retry(
          () =>
            model.turn(
              { system: [{ type: "text", text: prompt.system }], tools: [SUBMIT_TOOL], messages },
              {},
              req.signal,
            ),
          { attempts: 3, baseDelayMs: 1000, maxDelayMs: 15_000 },
          { signal: req.signal, isRetryable: transient },
        );
        messages.push({ role: "assistant", content: message.content } as MessageParam);
        const call = message.content.find(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === SUBMIT,
        );
        if (!call) {
          messages.push({ role: "user", content: `Answer by calling ${SUBMIT} with your proposal.` });
          continue;
        }
        const checked = checkProposal(graph, req.sample, call.input);
        const invalid = checked.ok ? checked.proposal.dropped.filter((d) => !d.reason.endsWith("better match.")) : [];
        if (checked.ok && (invalid.length === 0 || round === 2)) return done(checked.proposal, round);
        if (checked.ok) fallback = checked.proposal;
        const problem = checked.ok
          ? `Some bindings were not accepted:\n${invalid.map((d) => `- ${d.field} → ${d.attribute}: ${d.reason}`).join("\n")}\nFix or leave out those bindings and call ${SUBMIT} again with the whole proposal.`
          : `The proposal was not accepted: ${checked.error} Fix it and call ${SUBMIT} again.`;
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: problem }],
        });
      }
      if (fallback) return done(fallback, 2);
      throw new ProposalError("The AI did not return a usable proposal. Try again, or bind the fields by hand.");
    },
  );
}

export interface DiscoverInput {
  system: string;
  object: string;
  /** JSON records, CSV with a header, or one column per line. */
  sample: string;
  /** Send up to three example values per field to the model (default true). */
  includeValues?: boolean;
  /** Apply confident, non-conflicting bindings without review (default true). */
  autoApprove?: boolean;
  entityHint?: string;
  label?: string;
  signal?: AbortSignal;
}

/** Reads the sample, asks the model, checks and stores the proposal (applying what the policy allows). */
export async function discoverBindings(
  db: Db,
  actor: Actor,
  model: ModelClient,
  input: DiscoverInput,
): Promise<SemanticProposal> {
  assertCan(actor, "build");
  const system = SystemId.parse(input.system);
  const object = ObjectName.parse(input.object);
  const sample = describeSample(input.sample, { includeValues: input.includeValues ?? true });
  const graph = await loadSemanticGraph(db, actor.orgId);
  // The model call happens outside any database transaction.
  const proposal = await proposeBindings(model, graph, {
    system,
    object,
    sample,
    entityHint: input.entityHint || graph.object(system, object)?.entity,
    signal: input.signal,
  });
  return recordProposal(db, actor, {
    system,
    object,
    proposal,
    fields: sample.fields.map((f) => ({ field: f.field, type: f.type })),
    model: model.provider ? `${PROVIDERS[model.provider].name} · ${model.model}` : model.model,
    autoApproveAt: input.autoApprove === false ? null : AUTO_APPROVE_AT,
    label: input.label,
  });
}
