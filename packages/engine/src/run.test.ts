import { FlowDoc } from "@oicr/flow-schema";
import { describe, expect, it, vi } from "vitest";
import { type EngineDeps, type InvokeCall, runFlow, type StepRecord } from "./index.js";

const flow = (over: Record<string, unknown>) =>
  FlowDoc.parse({ schemaVersion: 1, style: "scheduled", trigger: { id: "t", type: "schedule" }, steps: [], ...over });

function harness(invoke: (c: InvokeCall) => unknown = () => ({ status: 200, body: {} })) {
  const records: StepRecord[] = [];
  const calls: InvokeCall[] = [];
  const deps: EngineDeps = {
    invoke: async (c) => {
      calls.push(c);
      return invoke(c);
    },
    record: (r) => {
      records.push(r);
    },
    sleep: async () => {},
  };
  return { deps, records, calls };
}

class ErrWithCode extends Error {
  constructor(
    public code: string,
    msg: string,
    public retryable = false,
  ) {
    super(msg);
  }
}

describe("runFlow", () => {
  it("runs invoke → map → invoke with bindings and records every step", async () => {
    const doc = flow({
      steps: [
        { id: "get", type: "invoke", connection: "src", operation: "GET /orders" },
        { id: "shape", type: "map", expression: '{ "ids": $get.body.orders.id, "n": $count($get.body.orders) }' },
        { id: "post", type: "invoke", connection: "dst", operation: "POST /batch", request: '{ "body": $shape }' },
      ],
      businessIds: [{ name: "count", expr: "$shape.n", primary: true }],
    });
    const h = harness((c) =>
      c.connection === "src"
        ? { status: 200, body: { orders: [{ id: 1 }, { id: 2 }] } }
        : { status: 201, body: { ok: true } },
    );
    const r = await runFlow(doc, {}, h.deps);
    expect(r.status).toBe("succeeded");
    expect(h.calls[1]?.request).toEqual({ body: { ids: [1, 2], n: 2 } });
    expect(h.records.map((x) => [x.seq, x.stepId, x.status])).toEqual([
      [1, "get", "succeeded"],
      [2, "shape", "succeeded"],
      [3, "post", "succeeded"],
    ]);
    expect(r.primaryBusinessId).toBe("2");
  });

  it("exposes the trigger as $trigger and as the context", async () => {
    const doc = flow({ steps: [{ id: "m", type: "map", expression: '{ "a": $trigger.x, "b": x }' }] });
    const h = harness();
    await runFlow(doc, { x: 5 }, h.deps);
    expect(h.records[0]?.output).toEqual({ a: 5, b: 5 });
  });

  it("loops with forEach, treating one item and none correctly", async () => {
    const doc = flow({
      steps: [
        {
          id: "loop",
          type: "forEach",
          over: "$trigger.items",
          as: "it",
          steps: [{ id: "m", type: "map", expression: "$it.v * 2" }],
        },
      ],
    });
    for (const [items, expected] of [
      [
        [{ v: 1 }, { v: 2 }],
        [2, 4],
      ],
      [{ v: 3 }, [6]],
      [undefined, []],
    ] as const) {
      const h = harness();
      await runFlow(doc, { items }, h.deps);
      const maps = h.records.filter((r) => r.stepId === "m");
      expect(maps.map((r) => r.output)).toEqual(expected);
      expect(maps.map((r) => r.iteration)).toEqual(expected.map((_, i) => i));
    }
  });

  it("branches with switch and otherwise", async () => {
    const doc = flow({
      steps: [
        {
          id: "sw",
          type: "switch",
          cases: [{ when: "$trigger.n > 10", label: "big", steps: [{ id: "a", type: "map", expression: "'big'" }] }],
          otherwise: [{ id: "b", type: "map", expression: "'small'" }],
        },
      ],
    });
    const big = harness();
    await runFlow(doc, { n: 11 }, big.deps);
    expect(big.records.map((r) => r.stepId)).toEqual(["sw", "a"]);
    expect(big.records[0]?.message).toBe("Took big.");
    const small = harness();
    await runFlow(doc, { n: 1 }, small.deps);
    expect(small.records.map((r) => r.stepId)).toEqual(["sw", "b"]);
  });

  it("assigns variables and loops with while", async () => {
    const doc = flow({
      variables: { i: { type: "number", initial: 0 } },
      steps: [
        {
          id: "w",
          type: "while",
          condition: "$vars.i < 3",
          steps: [{ id: "inc", type: "assign", assignments: [{ variable: "i", value: "$vars.i + 1" }] }],
        },
      ],
    });
    const h = harness();
    const r = await runFlow(doc, {}, h.deps);
    expect(r.vars.i).toBe(3);
    expect(h.records.filter((x) => x.stepId === "inc")).toHaveLength(3);
  });

  it("stops runaway loops", async () => {
    const doc = flow({
      steps: [
        {
          id: "w",
          type: "while",
          condition: "true",
          maxIterations: 5,
          steps: [{ id: "l", type: "log", message: "x" }],
        },
      ],
    });
    const r = await runFlow(doc, {}, harness().deps);
    expect(r.status).toBe("failed");
    expect(r.fault?.code).toBe("max_iterations");
  });

  it("catches faults in a scope and exposes $fault", async () => {
    const doc = flow({
      steps: [
        {
          id: "sc",
          type: "scope",
          steps: [{ id: "call", type: "invoke", connection: "c", operation: "POST /x" }],
          onFault: [{ id: "note", type: "map", expression: '$fault.code & ": " & $fault.message' }],
        },
        { id: "after", type: "log", message: "still running" },
      ],
    });
    const h = harness(() => {
      throw new ErrWithCode("http_422", "bad total");
    });
    const r = await runFlow(doc, {}, h.deps);
    expect(r.status).toBe("succeeded");
    expect(h.records.map((x) => [x.stepId, x.status])).toEqual([
      ["sc", "succeeded"],
      ["call", "failed"],
      ["note", "succeeded"],
      ["after", "succeeded"],
    ]);
    expect(h.records[2]?.output).toBe("http_422: bad total");
  });

  it("rethrows to the global fault handler and fails the run", async () => {
    const doc = flow({
      steps: [
        {
          id: "sc",
          type: "scope",
          steps: [{ id: "boom", type: "throw", code: "bad_data", message: "id {{$trigger.id}} is bad" }],
          onFault: [{ id: "re", type: "rethrow" }],
        },
      ],
      onFault: [{ id: "g", type: "log", message: "global saw {{$fault.code}}" }],
    });
    const h = harness();
    const r = await runFlow(doc, { id: 9 }, h.deps);
    expect(r.status).toBe("failed");
    expect(r.fault).toMatchObject({ code: "bad_data", message: "id 9 is bad", stepId: "boom" });
    expect(h.records.find((x) => x.stepId === "g")?.message).toBe("global saw bad_data");
  });

  it("retries retryable invoke errors with backoff, not others", async () => {
    let n = 0;
    const h = harness(() => {
      n++;
      if (n < 3) throw new ErrWithCode("http_503", "down", true);
      return { status: 200 };
    });
    const sleeps: number[] = [];
    h.deps.sleep = async (ms) => {
      sleeps.push(ms);
    };
    h.deps.random = () => 1; // top of the jitter band: the full exponential wait
    const doc = flow({
      steps: [
        { id: "c", type: "invoke", connection: "x", operation: "GET /", retry: { attempts: 3, backoffSeconds: 2 } },
      ],
    });
    const r = await runFlow(doc, {}, h.deps);
    expect(r.status).toBe("succeeded");
    expect(sleeps).toEqual([2000, 4000]);
    expect(h.records[0]?.message).toBe("Succeeded on attempt 3 of 3.");

    let m = 0;
    const h2 = harness(() => {
      m++;
      throw new ErrWithCode("http_400", "nope", false);
    });
    const r2 = await runFlow(doc, {}, h2.deps);
    expect(r2.fault?.code).toBe("http_400");
    expect(m).toBe(1);
  });

  it("jitters retry waits within their band and honours Retry-After", async () => {
    const doc = flow({
      steps: [
        { id: "c", type: "invoke", connection: "x", operation: "GET /", retry: { attempts: 3, backoffSeconds: 2 } },
      ],
    });
    let n = 0;
    const h = harness(() => {
      n++;
      if (n === 1) throw Object.assign(new ErrWithCode("http_503", "down", true), {});
      if (n === 2) throw Object.assign(new ErrWithCode("http_429", "slow down", true), { retryAfterMs: 30_000 });
      return { status: 200 };
    });
    const sleeps: number[] = [];
    h.deps.sleep = async (ms) => {
      sleeps.push(ms);
    };
    h.deps.random = () => 0; // bottom of the band: half the exponential wait
    await runFlow(doc, {}, h.deps);
    expect(sleeps).toEqual([1000, 30_000]);
  });

  it("traces the run and every step, marking faults", async () => {
    const { startTestTelemetry } = await import("@oicr/platform/otel");
    const { exporter } = startTestTelemetry();
    const doc = flow({
      steps: [
        { id: "m", type: "map", expression: '{ "a": 1 }' },
        { id: "boom", type: "throw", code: "bad_order", message: "Order is bad" },
      ],
    });
    await runFlow(doc, {}, harness().deps);
    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === "flow run")!;
    const fail = spans.find((s) => s.name === "step throw")!;
    expect(spans.find((s) => s.name === "step map")?.attributes["oicr.step_id"]).toBe("m");
    expect(fail.status.code).toBe(2);
    expect(fail.attributes["oicr.fault_code"]).toBe("bad_order");
    expect(fail.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(run.status.code).toBe(2);
    expect(run.attributes["oicr.steps_executed"]).toBe(2);
  });

  it("returns a response and ends the run", async () => {
    const doc = FlowDoc.parse({
      schemaVersion: 1,
      style: "application",
      trigger: { id: "t", type: "http", sync: true },
      steps: [
        { id: "r", type: "return", status: 201, body: '{ "echo": $trigger.msg }' },
        { id: "never", type: "log", message: "x" },
      ],
    });
    const h = harness();
    const r = await runFlow(doc, { msg: "hi" }, h.deps);
    expect(r.response).toEqual({ status: 201, body: { echo: "hi" } });
    expect(h.records.map((x) => x.stepId)).toEqual(["r"]);
  });

  it("stops cleanly", async () => {
    const doc = flow({
      steps: [
        { id: "s", type: "stop" },
        { id: "never", type: "log", message: "x" },
      ],
    });
    const r = await runFlow(doc, {}, harness().deps);
    expect(r).toMatchObject({ status: "succeeded", stopped: true, steps: 1 });
  });

  it("translates values with lookups, loading each lookup once", async () => {
    const doc = flow({
      steps: [
        {
          id: "m",
          type: "map",
          expression:
            '{ "a": $lookupValue("countries", "shop", $trigger.c, "erp"), "b": $lookupValue("countries", "shop", "FR", "erp", "??") }',
        },
        { id: "bad", type: "map", expression: '$lookupValue("missing", "a", 1, "b")' },
      ],
    });
    const h = harness();
    const lookup = vi.fn(async (name: string) =>
      name === "countries" ? { name, domains: ["shop", "erp"], rows: [["US", "USA"]] } : null,
    );
    const r = await runFlow(doc, { c: "US" }, { ...h.deps, lookup });
    expect(h.records[0]?.output).toEqual({ a: "USA", b: "??" });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(r.fault).toMatchObject({ code: "expression_error", stepId: "bad" });
    expect(r.fault?.message).toContain('Lookup "missing" does not exist.');
  });

  it("turns expression errors into faults on the step", async () => {
    const doc = flow({ steps: [{ id: "m", type: "map", expression: "$number('abc')" }] });
    const h = harness();
    const r = await runFlow(doc, {}, h.deps);
    expect(r.fault).toMatchObject({ code: "expression_error", stepId: "m" });
    expect(h.records[0]?.status).toBe("failed");
  });

  it("skips notify when email is not configured, sends when it is", async () => {
    const doc = flow({
      steps: [{ id: "n", type: "notify", to: ["{{$trigger.who}}"], subject: "Hi {{$trigger.who}}", body: "b" }],
    });
    const h = harness();
    await runFlow(doc, { who: "ops@example.com" }, h.deps);
    expect(h.records[0]?.status).toBe("skipped");
    const notify = vi.fn(async () => {});
    const h2 = harness();
    await runFlow(doc, { who: "ops@example.com" }, { ...h2.deps, notify });
    expect(notify).toHaveBeenCalledWith({ to: ["ops@example.com"], subject: "Hi ops@example.com", body: "b" });
  });

  it("enforces the step limit", async () => {
    const doc = flow({
      steps: [{ id: "f", type: "forEach", over: "[1..100]", as: "i", steps: [{ id: "l", type: "log", message: "x" }] }],
    });
    const r = await runFlow(doc, {}, { ...harness().deps, maxSteps: 20 });
    expect(r.fault?.code).toBe("step_limit");
  });

  it("honours cancellation", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runFlow(
      flow({ steps: [{ id: "l", type: "log", message: "x" }] }),
      {},
      { ...harness().deps, signal: ac.signal },
    );
    expect(r.fault?.code).toBe("aborted");
  });
});
