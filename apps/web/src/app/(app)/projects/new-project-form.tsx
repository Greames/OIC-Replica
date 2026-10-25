"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { createProjectAction, type FormState } from "./actions";

export function NewProjectForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createProjectAction, {});
  return (
    <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-1.5">
        <Label htmlFor="name">New project</Label>
        <Input id="name" name="name" placeholder="e.g. Orders sync" required maxLength={100} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create project"}
      </Button>
      <div className="sm:hidden">
        <FieldError>{state.error}</FieldError>
      </div>
      {state.error && (
        <div className="hidden sm:block sm:basis-full">
          <FieldError>{state.error}</FieldError>
        </div>
      )}
    </form>
  );
}
