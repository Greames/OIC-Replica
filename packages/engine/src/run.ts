import {
  type FlowDoc,
  LOOKUP_FUNCTION,
  type LookupTable,
  lookupFunction,
  type Step,
  templateExpressions,
} from "@oicr/flow-schema";
import { ATTR, attrs, backoffDelay, recordError, retryAfterOf, tracer } from "@oicr/platform";
import jsonata from "jsonata";

/** What one executed step looks like in the activity stream (S22). */
export interface StepRecord {
  seq: number;
  stepId: string;
  stepType: Step["type"];
  iteration: number | null;
  status: "succeeded" | "failed" | "skipped";
  input?: unknown;
  output?: unknown;
  message?: string;
  startedAt: Date;
  endedAt: Date;
}

export interface Fault {
  code: string;
  message: string;
  stepId?: string;
  details?: unknown;
}

export interface InvokeCall {
  stepId: string;
  connection: string;
  operation: string;
  config: Record<string, unknown>;
  request: unknown;
  signal?: AbortSignal;
}

export interface EngineDeps {
  /** Calls the connection's adapter. Throw an error with `code` (and `retryable`) to fault. */
  invoke(call: InvokeCall): Promise<unknown>;
  /** Sends an email for `notify` steps. Missing: the step is skipped. */
  notify?(msg: { to: string[]; subject: string; body: string }): Promise<void>;
  /** Called after every step. Awaited, so the run is persisted step by step. */
  record?(rec: StepRecord): Promise<void> | void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
  /** Total step executions allowed in one run (loops count each iteration). */
  maxSteps?: number;
  /** Finds a lookup by name for $lookupValue (null: no such lookup). */
  lookup?(name: string): Promise<LookupTable | null>;
  /**
   * Extra JSONata functions, by name without the $ (the semantic functions
   * of the run's plan). A step id of the same name shadows a function.
   */
  functions?: Record<string, (...args: never[]) => unknown>;
  /** Jitter source for retry waits (tests pass a fixed one). */
  random?(): number;
}

/** Longest wait a server's Retry-After can impose on one retry. */
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

export interface RunResult {
  status: "succeeded" | "failed";
  /** Set by a `return` step (sync http triggers). */
  response?: { status: number; body: unknown };
  /** true when a `stop` step ended the run. */
  stopped: boolean;
  fault?: Fault;
  businessIds: Record<string, string>;
  primaryBusinessId?: string;
  vars: Record<string, unknown>;
  steps: number;
}

class FaultSignal extends Error {
  constructor(public fault: Fault) {
    super(fault.message);
  }
}
class StopSignal extends Error {}
class ReturnSignal extends Error {
  constructor(public response: { status: number; body: unknown }) {
    super("return");
  }
}

const compiled = new Map<string, ReturnType<typeof jsonata>>();
function compile(source: string) {
  let expr = compiled.get(source);
  if (!expr) {
    expr = jsonata(source);
    if (compiled.size > 5000) compiled.clear();
    compiled.set(source, expr);
  }
  return expr;
}

/** JSONata turns one-element sequences into the element; loops want arrays. */
function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** JSONata sequences carry a `sequence` flag; strip it so payloads are plain JSON. */
function plain(v: unknown): unknown {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function toText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new FaultSignal({ code: "aborted", message: "The run was cancelled." }));
    });
  });
}

/**
 * Runs a validated FlowDoc. Pure: all I/O goes through `deps`.
 * Expressions see $trigger, $vars, $<stepId>, loop items and $fault
 * (see packages/flow-schema/src/schema.ts).
 */
export function runFlow(doc: FlowDoc, trigger: unknown, deps: EngineDeps): Promise<RunResult> {
  return tracer().startActiveSpan(
    "flow run",
    { attributes: attrs({ "oicr.flow_style": doc.style, "oicr.trigger_type": doc.trigger.type }) },
    async (span) => {
      try {
        const result = await runFlowInner(doc, trigger, deps);
        span.setAttribute("oicr.steps_executed", result.steps);
        if (result.status === "failed") {
          span.setAttribute("oicr.fault_code", result.fault?.code ?? "unknown");
          recordError(span, undefined, result.fault?.message ?? "The run failed.");
        }
        return result;
      } catch (e) {
        recordError(span, e);
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

async function runFlowInner(doc: FlowDoc, trigger: unknown, deps: EngineDeps): Promise<RunResult> {
  const maxSteps = deps.maxSteps ?? 10_000;
  const sleep = deps.sleep ?? defaultSleep;
  const vars: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(doc.variables)) vars[name] = structuredClone(v.initial ?? null);
  const outputs: Record<string, unknown> = {};
  let seq = 0;
  let executed = 0;

  interface Scope {
    loop: Record<string, unknown>;
    fault?: Fault;
    iteration: number | null;
  }

  const lookupValue = lookupFunction(async (name) => {
    if (!deps.lookup) throw new Error("Lookups are not available here.");
    return deps.lookup(name);
  });
  const bindings = (scope: Scope): Record<string, unknown> => ({
    ...deps.functions,
    [LOOKUP_FUNCTION]: lookupValue,
    ...outputs,
    ...scope.loop,
    trigger,
    vars,
    ...(scope.fault ? { fault: scope.fault } : {}),
  });

  const evaluate = async (source: string, scope: Scope, stepId: string): Promise<unknown> => {
    try {
      return plain(await compile(source).evaluate(trigger, bindings(scope)));
    } catch (e) {
      if (e instanceof FaultSignal) throw e;
      const err = e as { message?: string; code?: string };
      throw new FaultSignal({
        code: "expression_error",
        message: `Expression failed: ${err.message ?? String(e)}`,
        stepId,
        details: { expression: source, jsonataCode: err.code },
      });
    }
  };

  const render = async (template: string, scope: Scope, stepId: string): Promise<string> => {
    let out = "";
    let last = 0;
    const re = /\{\{([\s\S]*?)\}\}/g;
    const parts = templateExpressions(template);
    let i = 0;
    for (let m = re.exec(template); m; m = re.exec(template)) {
      out += template.slice(last, m.index);
      const src = parts[i++]?.source ?? "";
      out += src ? toText(await evaluate(src, scope, stepId)) : "";
      last = m.index + m[0].length;
    }
    return out + template.slice(last);
  };

  const record = async (rec: Omit<StepRecord, "seq">) => {
    seq += 1;
    await deps.record?.({ ...rec, seq });
  };

  const runSteps = async (steps: Step[], scope: Scope): Promise<void> => {
    for (const step of steps) await runStep(step, scope);
  };

  // Every step runs in its own span. Faults mark it failed; stop and return are not errors.
  const runStep = (step: Step, scope: Scope): Promise<void> =>
    tracer().startActiveSpan(
      `step ${step.type}`,
      {
        attributes: attrs({
          [ATTR.step]: step.id,
          [ATTR.stepType]: step.type,
          [ATTR.iteration]: scope.iteration,
          [ATTR.connection]: step.type === "invoke" ? step.connection : undefined,
        }),
      },
      async (span) => {
        try {
          await runStepInner(step, scope);
        } catch (e) {
          if (e instanceof FaultSignal) {
            span.setAttribute("oicr.fault_code", e.fault.code);
            recordError(span, e, e.fault.message);
          } else if (!(e instanceof StopSignal) && !(e instanceof ReturnSignal)) recordError(span, e);
          throw e;
        } finally {
          span.end();
        }
      },
    );

  const runStepInner = async (step: Step, scope: Scope): Promise<void> => {
    if (deps.signal?.aborted)
      throw new FaultSignal({ code: "aborted", message: "The run was cancelled.", stepId: step.id });
    executed += 1;
    if (executed > maxSteps) {
      throw new FaultSignal({
        code: "step_limit",
        message: `The run went over ${maxSteps} steps. Check loops for a missing exit.`,
        stepId: step.id,
      });
    }

    const startedAt = new Date();
    let input: unknown;
    let output: unknown;
    let message: string | undefined;
    let status: StepRecord["status"] = "succeeded";
    const base = { stepId: step.id, stepType: step.type, iteration: scope.iteration };

    try {
      switch (step.type) {
        case "invoke": {
          input = step.request ? await evaluate(step.request, scope, step.id) : undefined;
          const attempts = step.retry?.attempts ?? 1;
          for (let attempt = 1; ; attempt++) {
            try {
              const signal = step.timeoutSeconds
                ? AbortSignal.any([
                    AbortSignal.timeout(step.timeoutSeconds * 1000),
                    ...(deps.signal ? [deps.signal] : []),
                  ])
                : deps.signal;
              output = plain(
                await deps.invoke({
                  stepId: step.id,
                  connection: step.connection,
                  operation: step.operation,
                  config: step.config,
                  request: input,
                  signal,
                }),
              );
              if (attempt > 1) message = `Succeeded on attempt ${attempt} of ${attempts}.`;
              break;
            } catch (e) {
              const err = e as { code?: string; message?: string; retryable?: boolean; details?: unknown };
              if (attempt >= attempts || !err.retryable) {
                throw new FaultSignal({
                  code: err.code ?? "invoke_failed",
                  message: err.message ?? String(e),
                  stepId: step.id,
                  details: { ...(err.details as object), attempts: attempt },
                });
              }
              // Exponential backoff with jitter; a longer Retry-After from the server wins.
              const backoff = backoffDelay(
                attempt,
                {
                  attempts,
                  baseDelayMs: (step.retry?.backoffSeconds ?? 5) * 1000,
                  maxDelayMs: 5 * 60 * 1000,
                  jitter: "equal",
                },
                deps.random,
              );
              const wait = Math.max(backoff, Math.min(retryAfterOf(e) ?? 0, MAX_RETRY_AFTER_MS));
              tracer()
                .startSpan("retry wait", {
                  attributes: attrs({
                    [ATTR.step]: step.id,
                    [ATTR.attempt]: attempt,
                    "oicr.wait_ms": wait,
                    "oicr.error_code": err.code,
                  }),
                })
                .end();
              await sleep(wait, deps.signal);
            }
          }
          outputs[step.id] = output;
          break;
        }
        case "map":
          output = await evaluate(step.expression, scope, step.id);
          outputs[step.id] = output;
          break;
        case "assign": {
          const changed: Record<string, unknown> = {};
          for (const a of step.assignments) {
            const v = await evaluate(a.value, scope, step.id);
            vars[a.variable] = v === undefined ? null : v;
            changed[a.variable] = vars[a.variable];
          }
          output = changed;
          break;
        }
        case "log":
          message = await render(step.message, scope, step.id);
          break;
        case "notify": {
          const msg = {
            to: await Promise.all(step.to.map((t) => render(t, scope, step.id))),
            subject: await render(step.subject, scope, step.id),
            body: await render(step.body, scope, step.id),
          };
          input = msg;
          if (deps.notify) {
            await deps.notify(msg);
            message = `Sent to ${msg.to.join(", ")}.`;
          } else {
            status = "skipped";
            message = "Email is not set up on this server, so nothing was sent.";
          }
          break;
        }
        case "wait":
          await sleep(step.seconds * 1000, deps.signal);
          break;
        case "throw":
          throw new FaultSignal({
            code: step.code,
            message: await render(step.message, scope, step.id),
            stepId: step.id,
          });
        case "rethrow":
          if (!scope.fault)
            throw new FaultSignal({ code: "rethrow_outside_fault", message: "Nothing to rethrow.", stepId: step.id });
          throw new FaultSignal(scope.fault);
        case "stop":
          throw new StopSignal();
        case "return": {
          const body = step.body ? await evaluate(step.body, scope, step.id) : null;
          output = { status: step.status, body };
          throw new ReturnSignal({ status: step.status, body });
        }
        case "js":
          throw new FaultSignal({
            code: "not_supported",
            message: "JavaScript library steps arrive in a later release.",
            stepId: step.id,
          });
        case "switch": {
          let taken = -1;
          for (const [i, c] of step.cases.entries()) {
            if (await evaluate(c.when, scope, step.id)) {
              taken = i;
              break;
            }
          }
          const label = taken >= 0 ? (step.cases[taken]?.label ?? `case ${taken + 1}`) : "otherwise";
          output = { branch: taken >= 0 ? taken : "otherwise" };
          message = `Took ${label}.`;
          await record({ ...base, status, output, message, startedAt, endedAt: new Date() });
          if (taken >= 0) await runSteps(step.cases[taken]?.steps ?? [], scope);
          else if (step.otherwise) await runSteps(step.otherwise, scope);
          return;
        }
        case "forEach": {
          const items = asArray(await evaluate(step.over, scope, step.id));
          await record({
            ...base,
            status,
            output: { count: items.length },
            message: `${items.length} item(s).`,
            startedAt,
            endedAt: new Date(),
          });
          for (const [i, item] of items.entries()) {
            await runSteps(step.steps, { ...scope, loop: { ...scope.loop, [step.as]: item }, iteration: i });
          }
          return;
        }
        case "while": {
          let i = 0;
          await record({ ...base, status, startedAt, endedAt: new Date() });
          while (await evaluate(step.condition, scope, step.id)) {
            if (i >= step.maxIterations) {
              throw new FaultSignal({
                code: "max_iterations",
                message: `The loop ran ${step.maxIterations} times without its condition turning false.`,
                stepId: step.id,
              });
            }
            await runSteps(step.steps, { ...scope, iteration: i });
            i++;
          }
          return;
        }
        case "scope": {
          await record({ ...base, status, startedAt, endedAt: new Date() });
          try {
            await runSteps(step.steps, scope);
          } catch (e) {
            if (!(e instanceof FaultSignal) || !step.onFault) throw e;
            await runSteps(step.onFault, { ...scope, fault: e.fault });
          }
          return;
        }
      }
    } catch (e) {
      if (e instanceof StopSignal) {
        await record({ ...base, status: "succeeded", message: "Stopped the run.", startedAt, endedAt: new Date() });
        throw e;
      }
      if (e instanceof ReturnSignal) {
        await record({ ...base, status: "succeeded", output, startedAt, endedAt: new Date() });
        throw e;
      }
      if (e instanceof FaultSignal && e.fault.stepId === step.id) {
        await record({
          ...base,
          status: "failed",
          input,
          message: e.fault.message,
          output: { code: e.fault.code, details: e.fault.details },
          startedAt,
          endedAt: new Date(),
        });
      }
      throw e;
    }
    await record({ ...base, status, input, output, message, startedAt, endedAt: new Date() });
  };

  const top: Scope = { loop: {}, iteration: null };
  let result: Pick<RunResult, "status" | "response" | "stopped" | "fault">;
  try {
    await runSteps(doc.steps, top);
    result = { status: "succeeded", stopped: false };
  } catch (e) {
    if (e instanceof StopSignal) result = { status: "succeeded", stopped: true };
    else if (e instanceof ReturnSignal) result = { status: "succeeded", stopped: false, response: e.response };
    else if (e instanceof FaultSignal) {
      result = { status: "failed", stopped: false, fault: e.fault };
      if (doc.onFault) {
        try {
          await runSteps(doc.onFault, { ...top, fault: e.fault });
        } catch (inner) {
          if (inner instanceof FaultSignal) result.fault = inner.fault;
          else if (inner instanceof ReturnSignal) result.response = inner.response;
        }
      }
    } else {
      result = { status: "failed", stopped: false, fault: { code: "engine_error", message: (e as Error).message } };
    }
  }

  // Business identifiers: best effort, from everything the run produced.
  const businessIds: Record<string, string> = {};
  let primaryBusinessId: string | undefined;
  for (const b of doc.businessIds) {
    try {
      const v = await compile(b.expr).evaluate(trigger, bindings(top));
      if (v === undefined || v === null) continue;
      businessIds[b.name] = toText(v);
      if (b.primary) primaryBusinessId = businessIds[b.name];
    } catch {
      // a missing identifier never fails a run
    }
  }

  return { ...result, businessIds, primaryBusinessId, vars, steps: seq };
}
