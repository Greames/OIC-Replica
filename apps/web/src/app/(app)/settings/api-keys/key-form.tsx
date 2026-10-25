"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import type { ActionResult } from "@/lib/errors";
import { createApiKeyAction } from "../actions";
import { CopyButton } from "../copy-button";

export function KeyForm({
  defaultName = "",
  defaultBuild = false,
  defaultOperate = false,
}: {
  defaultName?: string;
  defaultBuild?: boolean;
  defaultOperate?: boolean;
}) {
  const [state, action, pending] = useActionState<ActionResult & { key?: string }, FormData>(createApiKeyAction, {});
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            name="name"
            defaultValue={defaultName}
            placeholder="e.g. Hermes Agent"
            required
            maxLength={80}
          />
        </div>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 text-sm font-medium">What it may do</legend>
          <label className="flex items-start gap-2 text-fg-muted">
            <input type="checkbox" checked disabled className="mt-1" />{" "}
            <span>
              <b className="text-fg">Read</b>: integrations, runs, activity (always)
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" name="operate" defaultChecked={defaultOperate} className="mt-1" />
            <span>
              <b>Operate</b>: activate, deactivate and run integrations
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" name="build" defaultChecked={defaultBuild} className="mt-1" />
            <span>
              <b>Build</b>: ask the AI builder and apply its proposals
            </span>
          </label>
        </fieldset>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create key"}
          </Button>
        </div>
        <FieldError>{state.error}</FieldError>
      </form>
      {state.key && (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-success/40 bg-success/5 p-3 text-sm">
          <p className="font-medium">Copy the key now. It is not shown again.</p>
          <code className="break-all font-mono text-xs" data-testid="new-api-key">
            {state.key}
          </code>
          <div>
            <CopyButton text={state.key} label="Copy key" />
          </div>
        </div>
      )}
    </div>
  );
}
