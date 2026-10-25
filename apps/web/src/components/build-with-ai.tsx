"use client";

import { Sparkles } from "lucide-react";
import { useActionState } from "react";
import { startAiSessionAction } from "@/app/(app)/ai/actions";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";

const EXAMPLES = [
  "Every 15 minutes, send new orders from our orders API to the shop API, and email ops@example.com if one fails.",
  "When our website posts a contact form, create the contact in our CRM and answer with its id.",
];

export function BuildWithAi({ projects, enabled }: { projects: { id: string; name: string }[]; enabled: boolean }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(startAiSessionAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <textarea
        name="text"
        aria-label="Describe the integration you want"
        placeholder={EXAMPLES[0]}
        required
        disabled={!enabled}
        rows={3}
        className="w-full resize-none rounded-lg border border-border bg-panel px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent disabled:bg-muted"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select name="projectId" aria-label="Project" className="w-auto" disabled={!enabled}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={!enabled || pending}>
          <Sparkles aria-hidden /> {pending ? "Starting…" : "Build it"}
        </Button>
      </div>
      <FieldError>{state.error}</FieldError>
    </form>
  );
}

export function EditWithAi({ integrationId }: { integrationId: string }) {
  const [, action, pending] = useActionState<ActionResult, FormData>(startAiSessionAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="integrationId" value={integrationId} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        <Sparkles aria-hidden /> Edit with AI
      </Button>
    </form>
  );
}
