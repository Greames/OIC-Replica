"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { createIntegrationAction } from "./actions";

export function NewIntegrationForm({
  projects,
  defaultProjectId,
}: {
  projects: { id: string; name: string }[];
  defaultProjectId?: string;
}) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(createIntegrationAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-name">New integration</Label>
        <Input id="int-name" name="name" placeholder="e.g. Orders to shop" required maxLength={100} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-project">Project</Label>
        <Select id="int-project" name="projectId" defaultValue={defaultProjectId ?? projects[0]?.id}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="int-style">Starts</Label>
        <Select id="int-style" name="style" defaultValue="scheduled">
          <option value="scheduled">On a schedule</option>
          <option value="application">When called (HTTP)</option>
        </Select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create"}
      </Button>
      {state.error && (
        <div className="sm:col-span-4">
          <FieldError>{state.error}</FieldError>
        </div>
      )}
    </form>
  );
}
