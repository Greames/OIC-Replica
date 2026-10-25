"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { setScheduleAction } from "../actions";

export function ScheduleForm({
  id,
  initial,
  disabled,
}: {
  id: string;
  initial: { kind: "interval" | "cron"; expression: string; timezone: string } | null;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(setScheduleAction.bind(null, id), {});
  const [kind, setKind] = useState(initial?.kind ?? "interval");
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-end">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="kind">Repeat</Label>
        <Select
          id="kind"
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as "interval")}
          disabled={disabled}
        >
          <option value="interval">Every…</option>
          <option value="cron">Cron</option>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="expression">{kind === "interval" ? "Interval" : "Cron expression"}</Label>
        <Input
          id="expression"
          name="expression"
          className="font-mono"
          defaultValue={initial?.expression ?? (kind === "interval" ? "PT15M" : "0 9 * * 1-5")}
          placeholder={kind === "interval" ? "PT15M = every 15 minutes" : "0 9 * * 1-5 = weekdays 9:00"}
          required
          disabled={disabled}
        />
        <FieldError>{state.fieldErrors?.expression}</FieldError>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="timezone">Time zone</Label>
        <Input
          id="timezone"
          name="timezone"
          defaultValue={initial?.timezone ?? "UTC"}
          placeholder="Europe/London"
          disabled={disabled}
        />
        <FieldError>{state.fieldErrors?.timezone}</FieldError>
      </div>
      <Button type="submit" variant="secondary" disabled={pending || disabled}>
        {pending ? "Saving…" : "Save schedule"}
      </Button>
      {(state.message || (state.error && !state.fieldErrors)) && (
        <p role="status" className={`text-sm sm:col-span-4 ${state.ok ? "text-success" : "text-danger"}`}>
          {state.message ?? state.error}
        </p>
      )}
    </form>
  );
}
