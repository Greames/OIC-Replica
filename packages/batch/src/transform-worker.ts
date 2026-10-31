import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { LOOKUP_FUNCTION, type LookupTable, lookupFunction } from "@oicr/flow-schema";
import { type SemanticPlan, semanticFunctions } from "@oicr/semantic";
import jsonata from "jsonata";

// Per-record transforms of a pipeline, run on worker threads so CPU-heavy
// JSONata never blocks the event loop that reads and writes. This module is
// also used in-process (threads = 0). It imports packages only, so it runs as
// a worker both from TypeScript sources (tests) and from dist.

export interface TransformSetup {
  filter?: string;
  transform?: string;
  /** $trigger, $vars and earlier steps' outputs, as they were when the pipeline started. */
  bindings: Record<string, unknown>;
  /** Lookups the expressions use, loaded up front (workers have no database). */
  lookups: LookupTable[];
  semantics: SemanticPlan | null;
}

export interface RowError {
  index: number;
  code: string;
  message: string;
}

export interface TransformOutcome {
  /** One entry per input row: the record to write, or null when filtered out or failed. */
  out: (Record<string, unknown> | null)[];
  errors: RowError[];
  filtered: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Compiles the expressions once; the returned function transforms a chunk. */
export function compileTransform(
  setup: TransformSetup,
): (rows: Record<string, unknown>[]) => Promise<TransformOutcome> {
  const filter = setup.filter ? jsonata(setup.filter) : null;
  const transform = setup.transform ? jsonata(setup.transform) : null;
  const tables = new Map(setup.lookups.map((t) => [t.name, t]));
  const base: Record<string, unknown> = {
    ...semanticFunctions(setup.semantics),
    [LOOKUP_FUNCTION]: lookupFunction((name) => tables.get(name) ?? null),
    ...setup.bindings,
  };
  return async (rows) => {
    const out: TransformOutcome["out"] = [];
    const errors: RowError[] = [];
    let filtered = 0;
    for (const [index, record] of rows.entries()) {
      const bindings = { ...base, record };
      try {
        if (filter && !(await filter.evaluate(record, bindings))) {
          out.push(null);
          filtered++;
          continue;
        }
        const value = transform ? await transform.evaluate(record, bindings) : record;
        if (!isRecord(value)) {
          out.push(null);
          errors.push({
            index,
            code: "transform_not_a_record",
            message: `The transform must give one record (an object), got ${value === undefined ? "nothing" : Array.isArray(value) ? "a list" : typeof value}.`,
          });
          continue;
        }
        out.push(JSON.parse(JSON.stringify(value)));
      } catch (e) {
        out.push(null);
        errors.push({ index, code: "expression_error", message: (e as Error).message });
      }
    }
    return { out, errors, filtered };
  };
}

// ── worker side ───────────────────────────────────────────────────────────

export type WorkerRequest = { id: number; rows: Record<string, unknown>[] };
/** id 0: the worker compiled its expressions and is ready; -1: it could not. */
export type WorkerResponse = { id: number; outcome?: TransformOutcome; error?: string };

if (!isMainThread && parentPort && (workerData as { oicrTransform?: boolean } | null)?.oicrTransform) {
  const port = parentPort;
  let run: ((rows: Record<string, unknown>[]) => Promise<TransformOutcome>) | null = null;
  try {
    run = compileTransform((workerData as { setup: TransformSetup }).setup);
    port.postMessage({ id: 0 } satisfies WorkerResponse);
  } catch (e) {
    port.postMessage({ id: -1, error: (e as Error).message } satisfies WorkerResponse);
  }
  port.on("message", (msg: WorkerRequest) => {
    if (!run) return port.postMessage({ id: msg.id, error: "The transform could not be compiled." });
    run(msg.rows).then(
      (outcome) => port.postMessage({ id: msg.id, outcome } satisfies WorkerResponse),
      (e: Error) => port.postMessage({ id: msg.id, error: e.message } satisfies WorkerResponse),
    );
  });
}
