import { z } from "zod";

/**
 * FlowDoc: the single source of truth for an integration.
 *
 * The canvas edits it, the AI proposes changes to it, the API stores it, and
 * the engine runs it. All of them go through `validateFlow`.
 *
 * Expressions are JSONata, evaluated with these bindings:
 *   $trigger      the trigger payload (request body, or schedule info)
 *   $vars         declared variables (see `variables`, changed by `assign`)
 *   $<stepId>     the output of a step that already ran, e.g. $n1.rows
 *   $<as>         the current item inside a forEach, e.g. $order
 *   $fault        the caught fault inside an onFault block
 * Text fields that say "template" take literal text with {{ expression }}
 * parts, e.g. "Order {{$order.id}} failed".
 */

export const SCHEMA_VERSION = 1 as const;

/** Step ids: short, stable, and usable as a JSONata variable name. */
export const StepId = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/, "must start with a letter and use only letters, digits and _");

export const Expression = z.string().min(1).describe("JSONata expression");
export const Template = z.string().describe("text with {{ JSONata }} parts");

const base = {
  id: StepId,
  label: z.string().max(120).optional().describe("short name shown on the canvas"),
  description: z.string().max(2000).optional(),
};

// ── triggers ──────────────────────────────────────────────────────────────

export const ScheduleTrigger = z.object({
  id: StepId,
  type: z.literal("schedule"),
});

export const HttpTrigger = z.object({
  id: StepId,
  type: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  path: z
    .string()
    .regex(/^\/[a-zA-Z0-9_\-/{}]*$/, "must start with / and use only URL-safe characters")
    .default("/"),
  sync: z.boolean().default(false).describe("true: the caller waits for a `return` step's response"),
  requestSchema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema of the request body"),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
});

export const AdapterTrigger = z.object({
  id: StepId,
  type: z.literal("adapter"),
  connection: z.string().min(1).describe("connection identifier with the trigger role"),
  operation: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const Trigger = z.discriminatedUnion("type", [ScheduleTrigger, HttpTrigger, AdapterTrigger]);

// ── steps ─────────────────────────────────────────────────────────────────

export const InvokeStep = z.object({
  ...base,
  type: z.literal("invoke"),
  connection: z.string().min(1).describe("connection identifier with the invoke role"),
  operation: z.string().min(1).describe("adapter operation, e.g. 'POST /orders' or 'query'"),
  config: z.record(z.string(), z.unknown()).default({}).describe("static, adapter-specific settings"),
  request: Expression.optional().describe('builds the request, e.g. { "body": $n2 }'),
  retry: z
    .object({
      attempts: z.number().int().min(1).max(10),
      backoffSeconds: z.number().int().min(1).max(3600).default(5),
    })
    .optional(),
  timeoutSeconds: z.number().int().min(1).max(300).optional(),
});

export const MapStep = z.object({
  ...base,
  type: z.literal("map"),
  expression: Expression.describe("its result becomes $<id>"),
  sourceSchema: z.record(z.string(), z.unknown()).optional(),
  targetSchema: z.record(z.string(), z.unknown()).optional(),
});

export const AssignStep = z.object({
  ...base,
  type: z.literal("assign"),
  assignments: z.array(z.object({ variable: z.string().min(1), value: Expression })).min(1),
});

export const ThrowStep = z.object({
  ...base,
  type: z.literal("throw"),
  code: z.string().min(1).max(80),
  message: Template,
});

export const RethrowStep = z.object({
  ...base,
  type: z.literal("rethrow"),
});

export const LogStep = z.object({
  ...base,
  type: z.literal("log"),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  message: Template,
});

export const NotifyStep = z.object({
  ...base,
  type: z.literal("notify"),
  channel: z.enum(["email"]).default("email"),
  to: z.array(z.string().min(1)).min(1).describe("addresses, or templates"),
  subject: Template,
  body: Template,
});

export const WaitStep = z.object({
  ...base,
  type: z.literal("wait"),
  seconds: z.number().int().min(1).max(3600),
});

export const StopStep = z.object({
  ...base,
  type: z.literal("stop"),
});

export const ReturnStep = z.object({
  ...base,
  type: z.literal("return"),
  status: z.number().int().min(100).max(599).default(200),
  body: Expression.optional(),
});

export const JsStep = z.object({
  ...base,
  type: z.literal("js"),
  library: z.string().min(1),
  function: z.string().min(1),
  args: z.array(Expression).default([]),
});

/**
 * A batch pipeline (batch engine): reads a source in chunks, transforms each
 * record, and writes chunks to a target, with bounded memory, a checkpoint
 * per chunk (a crashed run resumes where it stopped) and rejected records
 * kept aside instead of failing the run. Its output is the counts, never the data.
 */
export const PipelineStep = z.object({
  ...base,
  type: z.literal("pipeline"),
  source: z.object({
    connection: z.string().min(1).describe("connection whose adapter can read in batches (e.g. database)"),
    operation: z.string().min(1).describe('e.g. "read"'),
    config: z.record(z.string(), z.unknown()).default({}).describe("e.g. { sql, key } for a database"),
    params: Expression.optional().describe("evaluated once before reading; gives the source's parameters"),
  }),
  filter: Expression.optional().describe("per record ($record, also the context): false skips it"),
  transform: Expression.optional().describe("per record ($record): the record to write; default: unchanged"),
  target: z.object({
    connection: z.string().min(1).describe("connection whose adapter can write in batches"),
    operation: z.string().min(1).describe('e.g. "upsert" or "insert"'),
    config: z.record(z.string(), z.unknown()).default({}).describe("e.g. { table, key } for a database"),
  }),
  chunkSize: z.number().int().min(1).max(10_000).default(500),
  concurrency: z.number().int().min(1).max(8).default(2).describe("chunks transformed and written at once"),
  maxRejects: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .default(100)
    .describe("rejected records allowed before the step fails"),
});

// Container steps hold other steps. Their types are written out by hand so
// the recursion through `Step` stays explicit for TypeScript.

export interface SwitchStep extends StepBase {
  type: "switch";
  cases: { when: string; label?: string; steps: Step[] }[];
  otherwise?: Step[];
}
export interface ForEachStep extends StepBase {
  type: "forEach";
  over: string;
  as: string;
  parallel: boolean;
  steps: Step[];
}
export interface WhileStep extends StepBase {
  type: "while";
  condition: string;
  maxIterations: number;
  steps: Step[];
}
export interface ScopeStep extends StepBase {
  type: "scope";
  steps: Step[];
  onFault?: Step[];
}

interface StepBase {
  id: string;
  label?: string;
  description?: string;
}

export type LeafStep =
  | z.infer<typeof InvokeStep>
  | z.infer<typeof MapStep>
  | z.infer<typeof AssignStep>
  | z.infer<typeof ThrowStep>
  | z.infer<typeof RethrowStep>
  | z.infer<typeof LogStep>
  | z.infer<typeof NotifyStep>
  | z.infer<typeof WaitStep>
  | z.infer<typeof StopStep>
  | z.infer<typeof ReturnStep>
  | z.infer<typeof JsStep>
  | z.infer<typeof PipelineStep>;

export type Step = LeafStep | SwitchStep | ForEachStep | WhileStep | ScopeStep;

const steps = () => z.array(z.lazy((): z.ZodType<Step> => Step));

export const SwitchStepSchema = z.object({
  ...base,
  type: z.literal("switch"),
  cases: z
    .array(
      z.object({
        when: Expression.describe("true takes this branch; first match wins"),
        label: z.string().max(120).optional(),
        steps: steps(),
      }),
    )
    .min(1),
  otherwise: steps().optional(),
});

export const ForEachStepSchema = z.object({
  ...base,
  type: z.literal("forEach"),
  over: Expression.describe("must give an array"),
  as: StepId.describe("name of the current item, read as $<as>"),
  parallel: z.boolean().default(false),
  steps: steps().min(1),
});

export const WhileStepSchema = z.object({
  ...base,
  type: z.literal("while"),
  condition: Expression,
  maxIterations: z.number().int().min(1).max(10000).default(1000),
  steps: steps().min(1),
});

export const ScopeStepSchema = z.object({
  ...base,
  type: z.literal("scope"),
  steps: steps().min(1),
  onFault: steps().optional().describe("runs when a step inside fails; $fault holds the error"),
});

export const Step: z.ZodType<Step> = z
  .discriminatedUnion("type", [
    InvokeStep,
    MapStep,
    AssignStep,
    ThrowStep,
    RethrowStep,
    LogStep,
    NotifyStep,
    WaitStep,
    StopStep,
    ReturnStep,
    JsStep,
    PipelineStep,
    SwitchStepSchema,
    ForEachStepSchema,
    WhileStepSchema,
    ScopeStepSchema,
  ])
  .meta({ id: "Step" }) as unknown as z.ZodType<Step>;

export const StepType = z.enum([
  "invoke",
  "map",
  "assign",
  "throw",
  "rethrow",
  "log",
  "notify",
  "wait",
  "stop",
  "return",
  "js",
  "pipeline",
  "switch",
  "forEach",
  "while",
  "scope",
]);
export type StepType = z.infer<typeof StepType>;

// ── the document ──────────────────────────────────────────────────────────

export const Variable = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  initial: z.unknown().optional(),
});

export const BusinessId = z.object({
  name: z.string().min(1).max(60),
  expr: Expression,
  primary: z.boolean().default(false),
});

export const FlowDoc = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  style: z.enum(["application", "scheduled"]),
  trigger: Trigger,
  variables: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), Variable).default({}),
  steps: steps(),
  onFault: steps().optional().describe("global fault handler"),
  businessIds: z.array(BusinessId).max(3).default([]),
});

export type FlowDoc = z.infer<typeof FlowDoc>;
export type FlowDocInput = z.input<typeof FlowDoc>;
export type Trigger = z.infer<typeof Trigger>;
