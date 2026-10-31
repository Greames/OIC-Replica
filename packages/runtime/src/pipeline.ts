import { AdapterError, getAdapter } from "@oicr/adapters";
import { createTransformPool, PipelineError, tracedPipeline } from "@oicr/batch";
import {
  type Db,
  type Instance,
  loadCheckpoint,
  loadConnectionForRun,
  loadLookup,
  recordRejects,
  saveCheckpoint,
} from "@oicr/db";
import type { PipelineCall } from "@oicr/engine";
import { type LookupTable, parseExpression } from "@oicr/flow-schema";
import type { SemanticPlan } from "@oicr/semantic";
import { SecretStoreError } from "@oicr/vault";

// Runs one pipeline step for the batch engine: resolves the source and target
// connections (credentials from the secret store), loads what per-record
// expressions need (lookups, the plan's semantic bindings) for the transform
// workers, and resumes from the step's checkpoint when the run was resumed.

export interface PipelineContext {
  db: Db;
  instance: Instance;
  semantics: SemanticPlan | null;
  /** Wraps target writes in the connection's circuit breaker. */
  guard<T>(connection: string, fn: () => Promise<T>): Promise<T>;
}

async function connectionFor(ctx: PipelineContext, identifier: string, kind: "source" | "target") {
  let conn: Awaited<ReturnType<typeof loadConnectionForRun>>;
  try {
    conn = await loadConnectionForRun(ctx.db, ctx.instance.orgId, identifier);
  } catch (e) {
    if (e instanceof SecretStoreError && e.kind === "unavailable")
      throw new AdapterError(
        "secret_store_unavailable",
        `The credentials of "${identifier}" could not be read: the secret store is not reachable.`,
        undefined,
        true,
      );
    throw new AdapterError(
      "secret_unreadable",
      `The credentials of "${identifier}" could not be read (${(e as Error).message}).`,
    );
  }
  if (!conn) throw new AdapterError("connection_missing", `Connection "${identifier}" no longer exists.`);
  const batch = getAdapter(conn.adapter).batch;
  if (!batch)
    throw new AdapterError(
      "pipeline_connection",
      `Connection "${identifier}" (${conn.adapter}) cannot be a pipeline ${kind}.`,
    );
  return { config: conn.config, batch };
}

async function lookupsFor(ctx: PipelineContext, expressions: (string | undefined)[]): Promise<LookupTable[]> {
  const names = new Set(expressions.flatMap((e) => (e ? parseExpression(e).lookups : [])));
  const tables: LookupTable[] = [];
  for (const name of names) {
    const t = await loadLookup(ctx.db, ctx.instance.orgId, name);
    if (!t) throw new AdapterError("unknown_lookup", `Lookup "${name}" does not exist.`);
    tables.push(t);
  }
  return tables;
}

export async function runPipelineStep(ctx: PipelineContext, call: PipelineCall) {
  const { step } = call;
  const run = { id: ctx.instance.id, orgId: ctx.instance.orgId };
  const checkpoint = await loadCheckpoint(ctx.db, run, step.id);
  const counts = (c: NonNullable<typeof checkpoint>) => ({
    read: c.read,
    written: c.written,
    filtered: c.filtered,
    rejected: c.rejected,
    chunks: c.chunks,
  });
  // Finished in an earlier attempt of this run: nothing to redo.
  if (checkpoint?.status === "done") return { ...counts(checkpoint), resumed: true };

  const [source, target, lookups] = await Promise.all([
    connectionFor(ctx, step.source.connection, "source"),
    connectionFor(ctx, step.target.connection, "target"),
    lookupsFor(ctx, [step.filter, step.transform]),
  ]);
  const needsWorkers = !!(step.filter || step.transform);
  const pool = await createTransformPool(
    { filter: step.filter, transform: step.transform, bindings: call.bindings, lookups, semantics: ctx.semantics },
    needsWorkers ? {} : { threads: 0 },
  );
  try {
    const result = await tracedPipeline(
      { tenant: run.orgId, run: run.id, step: step.id },
      {
        read: (after) =>
          source.batch.read(source.config, {
            operation: step.source.operation,
            config: step.source.config,
            params: call.params,
            after,
            chunkSize: step.chunkSize,
            signal: call.signal,
          }),
        transform: (rows) => pool.run(rows),
        write: (rows) =>
          ctx.guard(step.target.connection, () =>
            target.batch.write(target.config, {
              operation: step.target.operation,
              config: step.target.config,
              rows,
              signal: call.signal,
            }),
          ),
        reject: (rejects) => recordRejects(ctx.db, run, step.id, rejects),
        checkpoint: (state) => saveCheckpoint(ctx.db, run, step.id, state),
        signal: call.signal,
      },
      {
        concurrency: step.concurrency,
        maxRejects: step.maxRejects,
        resume: checkpoint ? { ...counts(checkpoint), cursor: checkpoint.cursor } : null,
      },
    );
    await saveCheckpoint(ctx.db, run, step.id, { ...result, cursor: null }, "done");
    return result;
  } catch (e) {
    if (e instanceof PipelineError) throw e;
    throw e instanceof AdapterError
      ? e
      : new PipelineError("pipeline_failed", (e as Error).message, {
          read: 0,
          written: 0,
          filtered: 0,
          rejected: 0,
          chunks: 0,
        });
  } finally {
    await pool.close();
  }
}
