import { ATTR, recordError, retry, withSpan } from "@oicr/platform";
import type { TransformOutcome } from "./transform-worker.js";

// The batch engine's core: source → chunk → transform → write, with
//  - bounded memory: at most `concurrency` chunks in flight (plus the one being read),
//    and the source is only read when a slot is free (backpressure);
//  - checkpoints committed strictly in chunk order, so a resumed run continues
//    after the last chunk that fully finished and replays nothing else;
//  - rejected records set aside (transform errors, rows the target refused),
//    failing the step only past `maxRejects`;
//  - retryable write failures retried with backoff before the step fails.

export interface Counts {
  read: number;
  written: number;
  filtered: number;
  rejected: number;
  chunks: number;
}

export interface Checkpoint extends Counts {
  /** The source cursor after the last committed chunk. */
  cursor: unknown;
}

export interface Reject {
  chunk: number;
  /** Position of the record in its chunk. */
  index: number;
  stage: "transform" | "write";
  code: string;
  message: string;
  /** The record as read (transform rejects) or as it was to be written (write rejects). */
  record: Record<string, unknown>;
}

export interface PipelineIO {
  read(after: unknown): AsyncIterable<{ rows: Record<string, unknown>[]; cursor: unknown }>;
  transform(rows: Record<string, unknown>[]): Promise<TransformOutcome>;
  write(
    rows: Record<string, unknown>[],
  ): Promise<{ written: number; rejects: { index: number; code: string; message: string }[] }>;
  /** Persists a chunk's rejects; called in chunk order, before its checkpoint. */
  reject(rejects: Reject[]): Promise<void>;
  /** Persists progress; called in chunk order after each chunk completes. */
  checkpoint(state: Checkpoint): Promise<void>;
  signal?: AbortSignal;
}

export interface PipelineOptions {
  concurrency: number;
  maxRejects: number;
  /** Where an earlier attempt stopped. */
  resume?: Checkpoint | null;
  /** Attempts for a chunk's write when the target fails in a retryable way. */
  writeAttempts?: number;
}

export interface PipelineResult extends Counts {
  resumed: boolean;
}

/** A failure that ends the pipeline; its code becomes the step's fault code. */
export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly counts: Counts,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

interface ChunkResult {
  index: number;
  cursor: unknown;
  read: number;
  written: number;
  filtered: number;
  rejects: Reject[];
}

const errorCode = (e: unknown) => (e as { code?: unknown })?.code;

export async function runPipeline(io: PipelineIO, opts: PipelineOptions): Promise<PipelineResult> {
  const start = opts.resume ?? null;
  const counts: Counts = {
    read: start?.read ?? 0,
    written: start?.written ?? 0,
    filtered: start?.filtered ?? 0,
    rejected: start?.rejected ?? 0,
    chunks: start?.chunks ?? 0,
  };
  const inFlight: Promise<ChunkResult>[] = [];
  let nextIndex = counts.chunks;

  const processChunk = (index: number, rows: Record<string, unknown>[], cursor: unknown): Promise<ChunkResult> =>
    withSpan("pipeline chunk", { "oicr.chunk": index, "oicr.chunk_rows": rows.length }, async (span) => {
      const t = await io.transform(rows);
      const rejects: Reject[] = t.errors.map((e) => ({
        chunk: index,
        index: e.index,
        stage: "transform",
        code: e.code,
        message: e.message,
        record: rows[e.index] ?? {},
      }));
      const toWrite: Record<string, unknown>[] = [];
      const origin: number[] = [];
      t.out.forEach((r, i) => {
        if (r) {
          toWrite.push(r);
          origin.push(i);
        }
      });
      let written = 0;
      if (toWrite.length > 0) {
        const w = await retry(
          () => io.write(toWrite),
          { attempts: opts.writeAttempts ?? 4, baseDelayMs: 1000, maxDelayMs: 30_000 },
          {
            signal: io.signal,
            isRetryable: (e) => (e as { retryable?: boolean })?.retryable === true,
          },
        );
        written = w.written;
        for (const r of w.rejects)
          rejects.push({
            chunk: index,
            index: origin[r.index] ?? r.index,
            stage: "write",
            code: r.code,
            message: r.message,
            record: toWrite[r.index] ?? {},
          });
      }
      span.setAttributes({ "oicr.chunk_written": written, "oicr.chunk_rejected": rejects.length });
      if (rejects.length) recordError(span, undefined, `${rejects.length} record(s) rejected`);
      return { index, cursor, read: rows.length, written, filtered: t.filtered, rejects };
    });

  const commit = async (r: ChunkResult) => {
    if (r.rejects.length) await io.reject(r.rejects);
    counts.read += r.read;
    counts.written += r.written;
    counts.filtered += r.filtered;
    counts.rejected += r.rejects.length;
    counts.chunks = r.index + 1;
    await io.checkpoint({ ...counts, cursor: r.cursor });
    if (counts.rejected > opts.maxRejects) {
      const first = r.rejects[0];
      throw new PipelineError(
        "too_many_rejects",
        `${counts.rejected} records were rejected, more than the ${opts.maxRejects} allowed${first ? `; e.g. ${first.code}: ${first.message}` : ""}.`,
        { ...counts },
      );
    }
  };

  const fail = (e: unknown): never => {
    if (e instanceof PipelineError) throw e;
    const err = e as { message?: string; retryable?: boolean };
    const code = errorCode(e);
    throw new PipelineError(
      typeof code === "string" ? code : "pipeline_failed",
      err?.message ?? String(e),
      { ...counts },
      err?.retryable === true,
    );
  };

  try {
    for await (const chunk of io.read(start?.cursor ?? null)) {
      if (io.signal?.aborted) throw new PipelineError("aborted", "The pipeline was cancelled.", { ...counts });
      if (chunk.rows.length === 0) continue;
      const p = processChunk(nextIndex++, chunk.rows, chunk.cursor);
      // Observed when committed; this only stops an early failure from being "unhandled" meanwhile.
      p.catch(() => {});
      inFlight.push(p);
      // Backpressure: wait for the oldest chunk before reading more, and commit in order.
      if (inFlight.length >= opts.concurrency) await commit(await inFlight.shift()!);
    }
    while (inFlight.length) await commit(await inFlight.shift()!);
  } catch (e) {
    // Let chunks already running settle; nothing after the failure is committed.
    await Promise.allSettled(inFlight);
    fail(e);
  }
  return { ...counts, resumed: !!start };
}

/** Wraps runPipeline in a span with the counts. */
export function tracedPipeline(
  attrs: { tenant: string; run: string; step: string },
  io: PipelineIO,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  return withSpan(
    "pipeline",
    { [ATTR.tenant]: attrs.tenant, [ATTR.run]: attrs.run, [ATTR.step]: attrs.step, "oicr.resumed": !!opts.resume },
    async (span) => {
      const r = await runPipeline(io, opts);
      span.setAttributes({
        "oicr.read": r.read,
        "oicr.written": r.written,
        "oicr.rejected": r.rejected,
        "oicr.chunks": r.chunks,
      });
      return r;
    },
  );
}
