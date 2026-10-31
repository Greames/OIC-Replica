import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import {
  compileTransform,
  type TransformOutcome,
  type TransformSetup,
  type WorkerRequest,
  type WorkerResponse,
} from "./transform-worker.js";

export class TransformError extends Error {
  constructor(
    readonly code: "transform_timeout" | "transform_crashed" | "transform_invalid",
    message: string,
  ) {
    super(message);
    this.name = "TransformError";
  }
}

export interface TransformPool {
  run(rows: Record<string, unknown>[]): Promise<TransformOutcome>;
  close(): Promise<void>;
}

export interface PoolOptions {
  /** Worker threads; 0 transforms in this thread (tests, tiny pipelines). */
  threads?: number;
  /** Longest a chunk's transform may take before its worker is stopped. */
  chunkTimeoutMs?: number;
  /** Heap per worker, so one runaway transform cannot exhaust the process. */
  maxHeapMb?: number;
}

/** Threads for transforms: BATCH_THREADS, or one less than the CPUs (at least one). */
export const defaultThreads = () =>
  Number(process.env.BATCH_THREADS ?? Math.max(1, Math.min(4, availableParallelism() - 1)));

const workerUrl = new URL(
  import.meta.url.endsWith(".ts") ? "./transform-worker.ts" : "./transform-worker.js",
  import.meta.url,
);

interface Slot {
  worker: Worker;
  busy: boolean;
  /** Settles when the worker has loaded and compiled (start-up does not count against a chunk's timeout). */
  ready: Promise<void>;
}

/** A pool of transform workers sharing one setup (one pipeline step). */
export async function createTransformPool(setup: TransformSetup, opts: PoolOptions = {}): Promise<TransformPool> {
  const threads = opts.threads ?? defaultThreads();
  const timeoutMs = opts.chunkTimeoutMs ?? Number(process.env.BATCH_TRANSFORM_TIMEOUT_SECONDS ?? 120) * 1000;
  // Fail fast on expressions that do not compile, in this thread, with a clear message.
  let inline: ReturnType<typeof compileTransform>;
  try {
    inline = compileTransform(setup);
  } catch (e) {
    throw new TransformError("transform_invalid", `The pipeline's expressions are not valid: ${(e as Error).message}`);
  }
  if (threads <= 0) return { run: inline, close: async () => {} };

  const spawn = (): Slot => {
    const worker = new Worker(workerUrl, {
      workerData: { oicrTransform: true, setup },
      resourceLimits: { maxOldGenerationSizeMb: opts.maxHeapMb ?? 512 },
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: WorkerResponse) => {
        if (msg.id !== 0 && msg.id !== -1) return;
        cleanup();
        if (msg.id === 0) resolve();
        else reject(new TransformError("transform_invalid", msg.error ?? "The transform could not be compiled."));
      };
      const onFail = (e: unknown) => {
        cleanup();
        reject(
          new TransformError(
            "transform_crashed",
            `The transform worker did not start: ${String((e as Error)?.message ?? e)}`,
          ),
        );
      };
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onFail);
        worker.off("exit", onFail);
      };
      worker.on("message", onMessage);
      worker.on("error", onFail);
      worker.on("exit", onFail);
    });
    ready.catch(() => {});
    return { worker, busy: false, ready };
  };
  const slots: Slot[] = Array.from({ length: threads }, spawn);
  const waiting: ((s: Slot) => void)[] = [];
  let nextId = 1;
  let closed = false;

  const acquire = () =>
    new Promise<Slot>((resolve) => {
      const free = slots.find((s) => !s.busy);
      if (free) {
        free.busy = true;
        resolve(free);
      } else waiting.push(resolve);
    });
  const release = (slot: Slot) => {
    const next = waiting.shift();
    if (next) next(slot);
    else slot.busy = false;
  };
  const replace = (slot: Slot): Slot => {
    void slot.worker.terminate();
    const fresh = spawn();
    fresh.busy = slot.busy;
    slots[slots.indexOf(slot)] = fresh;
    return fresh;
  };

  return {
    async run(rows) {
      if (closed) throw new Error("The transform pool is closed.");
      let slot = await acquire();
      try {
        await slot.ready;
        return await new Promise<TransformOutcome>((resolve, reject) => {
          const id = nextId++;
          const worker = slot.worker;
          const done = () => {
            clearTimeout(timer);
            worker.off("message", onMessage);
            worker.off("error", onError);
            worker.off("exit", onExit);
          };
          const onMessage = (msg: WorkerResponse) => {
            if (msg.id !== id) return;
            done();
            if (msg.outcome) resolve(msg.outcome);
            else reject(new TransformError("transform_invalid", msg.error ?? "The transform failed."));
          };
          const onError = (e: Error) => {
            done();
            slot = replace(slot);
            reject(new TransformError("transform_crashed", `The transform worker stopped: ${e.message}`));
          };
          const onExit = (code: number) => {
            done();
            slot = replace(slot);
            reject(new TransformError("transform_crashed", `The transform worker exited (code ${code}).`));
          };
          const timer = setTimeout(() => {
            done();
            slot = replace(slot);
            reject(
              new TransformError(
                "transform_timeout",
                `Transforming one chunk took longer than ${Math.round(timeoutMs / 1000)} s; the transform may loop forever.`,
              ),
            );
          }, timeoutMs);
          worker.on("message", onMessage);
          worker.on("error", onError);
          worker.on("exit", onExit);
          worker.postMessage({ id, rows } satisfies WorkerRequest);
        });
      } finally {
        release(slot);
      }
    },
    async close() {
      closed = true;
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}
