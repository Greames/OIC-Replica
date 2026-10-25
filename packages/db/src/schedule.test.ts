import { describe, expect, it } from "vitest";
import { describeSchedule, intervalMs, nextRunAfter, ScheduleInput } from "./schedule.js";

describe("schedules", () => {
  it("parses ISO intervals", () => {
    expect(intervalMs("PT15M")).toBe(15 * 60_000);
    expect(intervalMs("P1DT2H")).toBe(26 * 3_600_000);
    expect(intervalMs("PT30S")).toBe(30_000);
    expect(intervalMs("P")).toBeNull();
    expect(intervalMs("PT")).toBeNull();
    expect(intervalMs("15m")).toBeNull();
  });

  it("validates input with readable messages", () => {
    const msg = (v: unknown) => {
      const r = ScheduleInput.safeParse(v);
      return r.success ? null : r.error.issues[0]?.message;
    };
    expect(msg({ kind: "interval", expression: "PT5M" })).toBeNull();
    expect(msg({ kind: "interval", expression: "PT30S" })).toMatch(/1 minute/);
    expect(msg({ kind: "interval", expression: "5 min" })).toMatch(/PT15M/);
    expect(msg({ kind: "cron", expression: "0 9 * *" })).toMatch(/5 cron fields/);
    expect(msg({ kind: "cron", expression: "0 99 * * *" })).toMatch(/cron/);
    expect(msg({ kind: "cron", expression: "0 9 * * 1-5", timezone: "Mars/Base" })).toMatch(/time zone/);
  });

  it("computes cron runs in the schedule's time zone across DST", () => {
    const s = { kind: "cron" as const, expression: "0 9 * * *", timezone: "America/New_York" };
    // 9:00 EDT is 13:00Z before Nov 1 2026; 9:00 EST is 14:00Z after.
    expect(nextRunAfter(s, new Date("2026-10-31T12:00:00Z")).toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(nextRunAfter(s, new Date("2026-11-01T12:00:00Z")).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("describes schedules for people", () => {
    expect(describeSchedule({ kind: "interval", expression: "PT15M", timezone: "UTC" })).toBe("every 15 minutes");
    expect(describeSchedule({ kind: "interval", expression: "PT1H", timezone: "UTC" })).toBe("every hour");
    expect(describeSchedule({ kind: "interval", expression: "P2D", timezone: "UTC" })).toBe("every 2 days");
    expect(describeSchedule({ kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/London" })).toBe(
      "0 9 * * 1-5 (Europe/London)",
    );
  });
});
