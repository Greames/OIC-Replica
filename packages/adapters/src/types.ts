import type { z } from "zod";

export type AuthType = "none" | "basic" | "api_key" | "bearer";
export type Role = "trigger" | "invoke";

/** A form field for the connection editor (S16) and the AI's request_connection tool. */
export interface Field {
  key: string;
  label: string;
  type: "text" | "url" | "password" | "number" | "select" | "keyvalue";
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Only shown for these auth types. */
  authTypes?: AuthType[];
  /** true: stored encrypted, never returned to the browser or the model. */
  secret?: boolean;
}

export interface ConnectionConfig {
  properties: Record<string, unknown>;
  authType: AuthType;
  secret: Record<string, unknown> | null;
}

export interface InvokeArgs {
  operation: string;
  config: Record<string, unknown>;
  /** Result of the step's `request` expression. */
  request: unknown;
  signal?: AbortSignal;
}

export interface TestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface BatchReadArgs {
  operation: string;
  config: Record<string, unknown>;
  /** The source's parameters (the pipeline's `params` expression). */
  params: Record<string, unknown>;
  /** Where the previous attempt stopped (a cursor from an earlier chunk), or null to start. */
  after: unknown;
  chunkSize: number;
  signal?: AbortSignal;
}

export interface BatchChunk {
  rows: Record<string, unknown>[];
  /** Resume position after this chunk (JSON); passed back as `after`. */
  cursor: unknown;
}

export interface BatchWriteArgs {
  operation: string;
  config: Record<string, unknown>;
  rows: Record<string, unknown>[];
  signal?: AbortSignal;
}

export interface BatchWriteResult {
  written: number;
  /** Rows the target refused, by index in `rows`; the others were written. */
  rejects: { index: number; code: string; message: string }[];
}

/**
 * Bulk reads and writes for the batch engine. Reads page through the source
 * and can resume from a cursor; writes are idempotent where the operation
 * allows (upserts), so a chunk replayed after a crash does not duplicate.
 */
export interface BatchCapabilities {
  readOperations: string[];
  writeOperations: string[];
  /** Checks a read or write configuration without connecting (activation-time errors). */
  checkConfig(kind: "read" | "write", operation: string, config: Record<string, unknown>): void;
  read(conn: ConnectionConfig, args: BatchReadArgs): AsyncIterable<BatchChunk>;
  write(conn: ConnectionConfig, args: BatchWriteArgs): Promise<BatchWriteResult>;
}

export interface Adapter<P = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  roles: Role[];
  authTypes: AuthType[];
  fields: Field[];
  properties: z.ZodType<P>;
  /** Describes the operation format, for the UI and the AI builder. */
  operationHelp: string;
  test(conn: ConnectionConfig): Promise<TestResult>;
  invoke(conn: ConnectionConfig, args: InvokeArgs): Promise<unknown>;
  /** Present when the adapter can be a pipeline's source or target. */
  batch?: BatchCapabilities;
  /** Releases pooled connections (process shutdown). */
  close?(): Promise<void>;
}

/** A failure the engine records as a fault: $fault.code / $fault.message. */
export class AdapterError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
    /** true when retrying could help (timeouts, 5xx, 429). */
    public retryable = false,
    /** The wait the server asked for (Retry-After), if any. */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
