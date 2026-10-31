import { compileObjects, SemanticGraph } from "@oicr/semantic";
import { describe, expect, it } from "vitest";
import {
  type Checkpoint,
  createTransformPool,
  PipelineError,
  type PipelineIO,
  type Reject,
  runPipeline,
  TransformError,
} from "./index.js";

const source = (total: number, size: number) =>
  async function* (after: unknown) {
    let next = (typeof after === "number" ? after : 0) + 1;
    while (next <= total) {
      const rows = [];
      for (let i = next; i < next + size && i <= total; i++) rows.push({ id: i, name: `n${i}` });
      next += rows.length;
      yield { rows, cursor: rows[rows.length - 1]!.id };
    }
  };

function harness(over: Partial<PipelineIO> = {}, total = 1000, size = 100) {
  const checkpoints: Checkpoint[] = [];
  const rejects: Reject[] = [];
  const written: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const io: PipelineIO = {
    read: source(total, size),
    transform: async (rows) => ({
      out: rows.map((r) => ({ ...r, upper: String(r.name).toUpperCase() })),
      errors: [],
      filtered: 0,
    }),
    async write(rows) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Later chunks finish first sometimes: commits must still be in order.
      await new Promise((r) => setTimeout(r, rows[0]!.id === 1 ? 30 : Math.random() * 5));
      inFlight--;
      written.push(...rows.map((r) => r.id as number));
      return { written: rows.length, rejects: [] };
    },
    reject: async (r) => {
      rejects.push(...r);
    },
    checkpoint: async (c) => {
      checkpoints.push(c);
    },
    ...over,
  };
  return { io, checkpoints, rejects, written, maxInFlight: () => maxInFlight };
}

describe("runPipeline", () => {
  it("moves every record with bounded concurrency and checkpoints in order", async () => {
    const h = harness();
    const r = await runPipeline(h.io, { concurrency: 3, maxRejects: 0 });
    expect(r).toEqual({ read: 1000, written: 1000, filtered: 0, rejected: 0, chunks: 10, resumed: false });
    expect(h.maxInFlight()).toBeLessThanOrEqual(3);
    expect(h.maxInFlight()).toBeGreaterThan(1);
    expect(h.checkpoints.map((c) => c.cursor)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(new Set(h.written).size).toBe(1000);
  });

  it("resumes after the last checkpoint without replaying committed chunks", async () => {
    const h = harness();
    const resume: Checkpoint = { cursor: 600, read: 600, written: 598, filtered: 0, rejected: 2, chunks: 6 };
    const r = await runPipeline(h.io, { concurrency: 2, maxRejects: 10, resume });
    expect(r).toMatchObject({ read: 1000, written: 998, rejected: 2, chunks: 10, resumed: true });
    expect(Math.min(...h.written)).toBe(601);
  });

  it("sets rejected records aside and fails past the threshold", async () => {
    const transform: PipelineIO["transform"] = async (rows) => ({
      out: rows.map((r) => ((r.id as number) % 50 === 0 ? null : r)),
      errors: rows.flatMap((r, index) =>
        (r.id as number) % 50 === 0 ? [{ index, code: "expression_error", message: "bad" }] : [],
      ),
      filtered: 0,
    });
    const write: PipelineIO["write"] = async (rows) => ({
      written: rows.length - 1,
      rejects: [{ index: 0, code: "sql_error", message: "value too large" }],
    });
    const ok = harness({ transform, write });
    const r = await runPipeline(ok.io, { concurrency: 2, maxRejects: 100 });
    expect(r).toMatchObject({ read: 1000, rejected: 30, written: 970 });
    expect(ok.rejects.filter((x) => x.stage === "transform")[0]).toMatchObject({
      chunk: 0,
      index: 49,
      record: { id: 50 },
    });
    expect(ok.rejects.filter((x) => x.stage === "write")[0]).toMatchObject({ chunk: 0, index: 0, record: { id: 1 } });

    const strict = harness({ transform, write });
    const err = await runPipeline(strict.io, { concurrency: 2, maxRejects: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineError);
    expect(err.code).toBe("too_many_rejects");
    // Rejects of committed chunks are kept, and progress up to the failure is checkpointed.
    expect(strict.checkpoints.at(-1)?.rejected).toBe(6);
    expect(strict.rejects).toHaveLength(6);
  });

  it("retries retryable write failures, and fails with progress kept otherwise", async () => {
    let calls = 0;
    const flaky = harness({
      write: async (rows) => {
        calls++;
        if (calls === 2) throw Object.assign(new Error("connection reset"), { code: "connection", retryable: true });
        return { written: rows.length, rejects: [] };
      },
    });
    expect((await runPipeline(flaky.io, { concurrency: 1, maxRejects: 0, writeAttempts: 2 })).written).toBe(1000);

    const broken = harness({
      write: async (rows) => {
        if ((rows[0]!.id as number) > 300)
          throw Object.assign(new Error("table does not exist"), { code: "sql_error" });
        return { written: rows.length, rejects: [] };
      },
    });
    const err = await runPipeline(broken.io, { concurrency: 1, maxRejects: 0 }).catch((e) => e);
    expect(err).toMatchObject({ code: "sql_error", retryable: false });
    expect(broken.checkpoints.at(-1)).toMatchObject({ cursor: 300, written: 300 });
  });

  it("stops when cancelled", async () => {
    const ac = new AbortController();
    const h = harness({
      checkpoint: async (c) => {
        if (c.chunks === 2) ac.abort();
      },
      signal: ac.signal,
    });
    await expect(runPipeline(h.io, { concurrency: 1, maxRejects: 0 })).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("transform pool", () => {
  const semantics = compileObjects(new SemanticGraph(), ["oracle-ebs/HZ_CUST_ACCOUNTS", "netsuite/customer"]);
  const setup = {
    filter: "$record.STATUS != 'X'",
    transform:
      '$merge([$translate($record, "oracle-ebs", "HZ_CUST_ACCOUNTS", "netsuite", "customer"), { "country": $lookupValue("countries", "ebs", COUNTRY, "ns", "??"), "batch": $trigger.batch }])',
    bindings: { trigger: { batch: "B1" } },
    lookups: [{ name: "countries", domains: ["ebs", "ns"], rows: [["US", "_US"]] }],
    semantics,
  };
  const rows = [
    { ACCOUNT_NUMBER: 1, ACCOUNT_NAME: "Acme", STATUS: "A", COUNTRY: "US" },
    { ACCOUNT_NUMBER: 2, ACCOUNT_NAME: "Gone", STATUS: "X", COUNTRY: "US" },
    { ACCOUNT_NUMBER: 3, ACCOUNT_NAME: "Globex", STATUS: "I", COUNTRY: "DE" },
  ];
  const expected = {
    out: [
      { entityId: "1", companyName: "Acme", isInactive: false, country: "_US", batch: "B1" },
      null,
      { entityId: "3", companyName: "Globex", isInactive: true, country: "??", batch: "B1" },
    ],
    errors: [],
    filtered: 1,
  };

  it("transforms on worker threads with lookups and the semantic plan", async () => {
    const pool = await createTransformPool(setup, { threads: 2 });
    try {
      const results = await Promise.all([pool.run(rows), pool.run(rows), pool.run(rows)]);
      for (const r of results) expect(r).toEqual(expected);
    } finally {
      await pool.close();
    }
  });

  it("gives the same result in-process, and reports bad records per row", async () => {
    const pool = await createTransformPool({ ...setup, filter: undefined, transform: "$record.list" }, { threads: 0 });
    expect(await pool.run([{ list: [1] }, { list: { ok: true } }])).toMatchObject({
      out: [null, { ok: true }],
      errors: [{ index: 0, code: "transform_not_a_record" }],
    });
    expect((await (await createTransformPool(setup, { threads: 0 })).run(rows)).out).toEqual(expected.out);
    await expect(createTransformPool({ ...setup, transform: "{ (" }, { threads: 0 })).rejects.toBeInstanceOf(
      TransformError,
    );
  });

  it("stops a transform that runs too long and keeps working", async () => {
    const pool = await createTransformPool(
      {
        bindings: {},
        lookups: [],
        semantics: null,
        transform: '$record.slow ? { "n": $count([1..3000000].($ * 2)) } : $record',
      },
      { threads: 1, chunkTimeoutMs: 50 },
    );
    try {
      await expect(pool.run([{ slow: true }])).rejects.toMatchObject({ code: "transform_timeout" });
      expect((await pool.run([{ slow: false, a: 1 }])).out).toEqual([{ slow: false, a: 1 }]);
    } finally {
      await pool.close();
    }
  });
});
