import { describe, expect, it } from "vitest";
import { validateFlow } from "./validate.js";

const pipeline = (over: Record<string, unknown> = {}) => ({
  id: "load",
  type: "pipeline",
  source: { connection: "ebs", operation: "read", config: { table: "HZ_CUST_ACCOUNTS", key: "CUST_ACCOUNT_ID" } },
  transform: '$translate($record, "oracle-ebs", "HZ_CUST_ACCOUNTS", "netsuite", "customer")',
  target: { connection: "dw", operation: "upsert", config: { table: "customers", key: "entityId" } },
  ...over,
});
const flow = (steps: unknown[], trigger: Record<string, unknown> = { id: "t", type: "schedule" }) => ({
  schemaVersion: 1,
  style: trigger.type === "schedule" ? "scheduled" : "application",
  trigger,
  steps,
});
const ctx = {
  connections: {
    ebs: { role: "invoke" as const, adapter: "database" },
    dw: { role: "invoke" as const, adapter: "database" },
    api: { role: "invoke" as const, adapter: "rest" },
  },
  batchOperations: { database: { read: ["read"], write: ["insert", "upsert"] } },
};
const codes = (r: ReturnType<typeof validateFlow>) => r.errors.map((e) => e.code);

describe("pipeline steps", () => {
  it("accept a scheduled load with defaults and $record in per-record expressions", () => {
    const r = validateFlow(flow([pipeline({ filter: "$record.STATUS = 'A' and $trigger.scheduledFor" })]), ctx);
    expect(r.errors).toEqual([]);
    if (!r.ok) return;
    expect(r.doc.steps[0]).toMatchObject({ chunkSize: 500, concurrency: 2, maxRejects: 100 });
  });

  it("are refused in sync requests and inside loops", () => {
    const sync = validateFlow(flow([pipeline()], { id: "t", type: "http", sync: true }), ctx);
    expect(codes(sync)).toContain("pipeline_in_sync_flow");
    const loop = validateFlow(
      flow([{ id: "each", type: "forEach", over: "[1,2]", as: "x", steps: [pipeline()] }]),
      ctx,
    );
    expect(codes(loop)).toEqual(["pipeline_in_loop"]);
  });

  it("need batch-capable connections and operations", () => {
    const r = validateFlow(
      flow([
        pipeline({
          source: { connection: "api", operation: "read" },
          target: { connection: "dw", operation: "merge" },
        }),
      ]),
      ctx,
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      'Connection "api" uses the rest adapter, which cannot be a pipeline source. Use a database connection.',
      'A database target uses the operation "insert" or "upsert", not "merge".',
    ]);
    expect(codes(validateFlow(flow([pipeline({ transform: "$order.id" })]), ctx))).toEqual(["unknown_reference"]);
  });
});
