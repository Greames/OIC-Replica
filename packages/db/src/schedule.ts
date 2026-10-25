import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

// Schedules: an ISO-8601 interval ("PT15M", "PT2H", "P1D") or a 5-field cron
// expression evaluated in an IANA time zone, so DST shifts land correctly.

const INTERVAL = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function intervalMs(expression: string): number | null {
  const m = expression.toUpperCase().match(INTERVAL);
  if (!m || expression.toUpperCase() === "P" || expression.toUpperCase().endsWith("T")) return null;
  const [, d, h, min, sec] = m;
  const ms = (((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min ?? 0)) * 60 + Number(sec ?? 0)) * 1000;
  return ms > 0 ? ms : null;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const ScheduleInput = z
  .object({
    kind: z.enum(["interval", "cron"]),
    expression: z.string().trim().min(1),
    timezone: z.string().default("UTC"),
    allowOverlap: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    if (!isValidTimezone(s.timezone)) {
      ctx.addIssue({
        code: "custom",
        path: ["timezone"],
        message: `"${s.timezone}" is not a time zone. Use a name like Europe/London.`,
      });
    }
    if (s.kind === "interval") {
      const ms = intervalMs(s.expression);
      if (ms === null) {
        ctx.addIssue({
          code: "custom",
          path: ["expression"],
          message: 'Use an interval like "PT15M" (15 minutes), "PT1H" or "P1D".',
        });
      } else if (ms < 60_000) {
        ctx.addIssue({ code: "custom", path: ["expression"], message: "The shortest interval is 1 minute." });
      }
    } else {
      if (s.expression.split(/\s+/).length !== 5) {
        ctx.addIssue({
          code: "custom",
          path: ["expression"],
          message: 'Use 5 cron fields: minute hour day month weekday, e.g. "0 9 * * 1-5".',
        });
        return;
      }
      try {
        CronExpressionParser.parse(s.expression, { tz: isValidTimezone(s.timezone) ? s.timezone : "UTC" });
      } catch (e) {
        ctx.addIssue({
          code: "custom",
          path: ["expression"],
          message: `Not a valid cron expression: ${(e as Error).message}`,
        });
      }
    }
  });
export type ScheduleInput = z.input<typeof ScheduleInput>;

/** The first run strictly after `from`. Intervals are anchored to `from`. */
export function nextRunAfter(s: { kind: "interval" | "cron"; expression: string; timezone: string }, from: Date): Date {
  if (s.kind === "interval") {
    const ms = intervalMs(s.expression);
    if (!ms) throw new Error(`Bad interval ${s.expression}`);
    return new Date(from.getTime() + ms);
  }
  return CronExpressionParser.parse(s.expression, { tz: s.timezone, currentDate: from }).next().toDate();
}

/** "every 15 minutes", "0 9 * * 1-5 (Europe/London)" */
export function describeSchedule(s: { kind: "interval" | "cron"; expression: string; timezone: string }): string {
  if (s.kind === "cron") return `${s.expression} (${s.timezone})`;
  const ms = intervalMs(s.expression) ?? 0;
  const mins = ms / 60_000;
  if (mins % 1440 === 0) return mins === 1440 ? "every day" : `every ${mins / 1440} days`;
  if (mins % 60 === 0) return mins === 60 ? "every hour" : `every ${mins / 60} hours`;
  return mins === 1 ? "every minute" : `every ${mins} minutes`;
}
