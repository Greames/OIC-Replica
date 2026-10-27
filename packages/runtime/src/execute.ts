import { AdapterError, getAdapter } from "@oicr/adapters";
import {
  appendStep,
  asSystem,
  asTenant,
  capPayload,
  type Db,
  emitEvent,
  finishInstance,
  type Instance,
  instances,
  integrations,
  loadConnectionForRun,
  loadLookup,
  loadPlan,
  PAYLOAD_LIMITS,
  startInstance,
} from "@oicr/db";
import { type EngineDeps, type RunResult, runFlow } from "@oicr/engine";
import { FlowDoc } from "@oicr/flow-schema";
import {
  ATTR,
  activeContext,
  BreakerRegistry,
  CircuitOpenError,
  type Context,
  recordError,
  SpanKind,
  tracer,
} from "@oicr/platform";
import { type SemanticFunctions, type SemanticPlan, semanticFunctions } from "@oicr/semantic";
import { SecretStoreError } from "@oicr/vault";
import { eq, sql } from "drizzle-orm";
import { emailNotifier } from "./email.js";

/** Breakers for this process, by "tenant:connection". Openings are announced as events. */
export const breakers = new BreakerRegistry(
  {
    failureThreshold: Number(process.env.BREAKER_FAILURES ?? 5),
    openMs: Number(process.env.BREAKER_OPEN_SECONDS ?? 30) * 1000,
  },
  (state, key) => {
    if (state !== "open" || !breakerEvents.db) return;
    const [orgId, connection] = key.split(":") as [string, string];
    void emitEvent(breakerEvents.db, {
      orgId,
      type: "connection.circuit_open",
      severity: "warning",
      subjectType: "connection",
      subjectId: orgId,
      summary: `Calls to connection ${connection} are paused after repeated failures; they resume automatically.`,
      path: "/connections",
      data: { connection },
    });
  },
);
const breakerEvents: { db?: Db } = {};

// Semantic functions by plan id. Plans are immutable, so entries never go stale.
const planFunctions = new Map<string, SemanticFunctions>();
function functionsFor(planId: string | null, semantics: SemanticPlan | null): SemanticFunctions {
  if (!planId) return semanticFunctions(null);
  let fns = planFunctions.get(planId);
  if (!fns) {
    if (planFunctions.size >= 500) planFunctions.delete(planFunctions.keys().next().value!);
    fns = semanticFunctions(semantics);
    planFunctions.set(planId, fns);
  }
  return fns;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  /** Trace context to continue (from the queued job or the HTTP request). */
  parent?: Context;
  /** Overrides for tests. */
  deps?: Partial<EngineDeps>;
}

export interface ExecuteResult {
  instance: Instance;
  result: RunResult | null;
}

/**
 * Runs one queued instance to the end: claims it, runs the FlowDoc through
 * the engine, writes every step as it happens, and records the outcome.
 * Returns null result if another worker had already claimed it.
 */
export function executeInstance(db: Db, instanceId: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
  return tracer().startActiveSpan(
    "integration execute",
    { kind: SpanKind.CONSUMER, attributes: { [ATTR.run]: instanceId } },
    opts.parent ?? activeContext(),
    async (span) => {
      try {
        const out = await executeInner(db, instanceId, opts);
        const i = out.instance;
        span.setAttributes({
          [ATTR.tenant]: i.orgId,
          [ATTR.integration]: i.integrationId,
          [ATTR.integrationVersion]: i.integrationVersion,
          [ATTR.trigger]: i.triggerKind,
          "oicr.run_status": i.status,
        });
        if (i.status === "failed") recordError(span, undefined, i.errorMessage ?? "The run failed.");
        return out;
      } catch (e) {
        recordError(span, e);
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

async function executeInner(db: Db, instanceId: string, opts: ExecuteOptions): Promise<ExecuteResult> {
  breakerEvents.db ??= db;
  const instance = await startInstance(db, instanceId);
  if (!instance) {
    // Another worker claimed it: report its current state.
    const [current] = await asSystem(db, "executeInstance:claimed", (db) =>
      db.select().from(instances).where(eq(instances.id, instanceId)),
    );
    return { instance: current!, result: null };
  }

  // From here on, everything runs as the run's own tenant. A run executes the
  // plan it was created with; runs from before plans existed use the definition.
  const plan = instance.planId ? await loadPlan(db, instance.orgId, instance.planId) : null;
  const [integration] = plan
    ? [{ definition: plan.definition, tracingLevel: plan.tracingLevel, semantics: plan.semantics }]
    : await asTenant(db, instance.orgId, (db) =>
        db
          .select({
            definition: integrations.definition,
            tracingLevel: integrations.tracingLevel,
            semantics: sql<SemanticPlan | null>`null`,
          })
          .from(integrations)
          .where(eq(integrations.id, instance.integrationId)),
      );
  if (!integration) {
    return {
      instance: await finishInstance(db, instance, {
        status: "failed",
        errorCode: "integration_missing",
        errorMessage: "The integration was deleted.",
      }),
      result: null,
    };
  }
  const parsed = FlowDoc.safeParse(integration.definition);
  if (!parsed.success) {
    return {
      instance: await finishInstance(db, instance, {
        status: "failed",
        errorCode: "invalid_definition",
        errorMessage: "The integration's definition is not valid. Open it to see the problems.",
      }),
      result: null,
    };
  }

  const tracing = integration.tracingLevel;
  const keep = (v: unknown, failed: boolean) =>
    tracing === "production" && !failed
      ? null
      : capPayload(v, tracing === "debug" ? PAYLOAD_LIMITS.debug : PAYLOAD_LIMITS.audit);

  const deps: EngineDeps = {
    signal: opts.signal,
    notify: emailNotifier(),
    lookup: (name) => loadLookup(db, instance.orgId, name),
    // Semantic references were compiled into the plan at activation.
    functions: functionsFor(plan?.id ?? null, integration.semantics ?? null),
    async invoke(call) {
      let conn: Awaited<ReturnType<typeof loadConnectionForRun>>;
      try {
        conn = await loadConnectionForRun(db, instance.orgId, call.connection);
      } catch (e) {
        // The secret store being down is worth retrying; a refusal or bad config is not.
        if (e instanceof SecretStoreError && e.kind === "unavailable")
          throw new AdapterError(
            "secret_store_unavailable",
            `The credentials of connection "${call.connection}" could not be read: the secret store is not reachable. Retry later.`,
            undefined,
            true,
          );
        throw new AdapterError(
          "secret_unreadable",
          `The credentials of connection "${call.connection}" could not be read (${(e as Error).message}). Check the secret store, or enter them again on the connection.`,
        );
      }
      if (!conn) throw new AdapterError("connection_missing", `Connection "${call.connection}" no longer exists.`);
      if (conn.role === "trigger") {
        throw new AdapterError("connection_role", `Connection "${call.connection}" can only be used as a trigger.`);
      }
      const resolved = conn;
      // One breaker per tenant and connection: a failing system is paused, not hammered.
      const breaker = breakers.get(`${instance.orgId}:${call.connection}`);
      try {
        return await breaker.run(
          () =>
            getAdapter(resolved.adapter).invoke(resolved.config, {
              operation: call.operation,
              config: call.config,
              request: call.request,
              signal: call.signal,
            }),
          (e) => e instanceof AdapterError && e.retryable && e.code !== "aborted",
        );
      } catch (e) {
        if (e instanceof CircuitOpenError)
          throw new AdapterError(
            "circuit_open",
            `${e.message} (connection "${call.connection}")`,
            { connection: call.connection },
            true,
            e.retryAfterMs,
          );
        throw e;
      }
    },
    async record(rec) {
      const failed = rec.status === "failed";
      await appendStep(db, instance, {
        seq: rec.seq,
        stepId: rec.stepId,
        stepType: rec.stepType,
        iteration: rec.iteration,
        status: rec.status,
        input: keep(rec.input, failed),
        output: keep(rec.output, failed),
        message: rec.message ?? null,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
      });
    },
    ...opts.deps,
  };

  let result: RunResult;
  try {
    result = await runFlow(parsed.data, instance.input ?? {}, deps);
  } catch (e) {
    return {
      instance: await finishInstance(db, instance, {
        status: "failed",
        errorCode: "engine_error",
        errorMessage: (e as Error).message,
      }),
      result: null,
    };
  }

  const finished = await finishInstance(db, instance, {
    status: result.fault?.code === "aborted" ? "aborted" : result.status,
    output: result.response ? keep(result.response, false) : null,
    errorCode: result.fault?.code ?? null,
    errorMessage: result.fault
      ? result.fault.stepId
        ? `${result.fault.stepId}: ${result.fault.message}`
        : result.fault.message
      : null,
    businessIds: result.businessIds,
    primaryBusinessId: result.primaryBusinessId ?? null,
  });
  return { instance: finished, result };
}
