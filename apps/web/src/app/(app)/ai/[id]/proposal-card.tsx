"use client";

import type { FlowDiff } from "@oicr/flow-schema";
import { Check, ExternalLink, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { acceptChangeAction, rejectChangeAction } from "../actions";

export interface ProposalView {
  id: string;
  name: string;
  summary: string;
  status: string;
  diff: FlowDiff;
  schedule: { kind: string; expression: string; timezone: string; text: string } | null;
  warnings: { message: string }[];
  definition: unknown;
  editsExisting: boolean;
  resultIntegrationId: string | null;
  needsSetup: { id: string; identifier: string }[];
}

function StepList({ title, steps, tone }: { title: string; steps: FlowDiff["added"]; tone: string }) {
  if (steps.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-fg-muted">{title}</div>
      <ul className="flex flex-wrap gap-1.5">
        {steps.map((s) => (
          <li key={s.id} className={`rounded-md px-2 py-0.5 font-mono text-xs ${tone}`}>
            {s.label ? `${s.label} ` : ""}
            <span className="opacity-70">
              {s.id}·{s.type}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProposalCard({ p, canBuild }: { p: ProposalView; canBuild: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const open = p.status === "proposed";

  return (
    <section aria-label={`Proposal: ${p.name}`} className="rounded-xl border-2 border-accent/30 bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-accent" aria-hidden />
        <h3 className="font-medium">{p.editsExisting ? `Changes to ${p.name}` : `New integration: ${p.name}`}</h3>
        <StatusBadge
          status={p.status === "proposed" ? "draft" : p.status === "accepted" ? "succeeded" : "inactive"}
          className="ml-auto"
        />
        <span className="sr-only">{p.status}</span>
      </div>
      <p className="mt-2 text-sm">{p.summary}</p>

      <div className="mt-3 flex flex-col gap-2">
        <StepList title="Adds" steps={p.diff.added} tone="bg-success/15 text-success" />
        <StepList title="Changes" steps={p.diff.changed} tone="bg-accent/15 text-accent" />
        <StepList title="Moves" steps={p.diff.moved} tone="bg-muted text-fg-muted" />
        <StepList title="Removes" steps={p.diff.removed} tone="bg-danger/15 text-danger line-through" />
        {p.editsExisting && (p.diff.triggerChanged || p.diff.businessIdsChanged || p.diff.faultHandlerChanged) ? (
          <p className="text-xs text-fg-muted">
            Also changes:{" "}
            {[
              p.diff.triggerChanged && p.editsExisting && "trigger",
              p.diff.businessIdsChanged && "business IDs",
              p.diff.faultHandlerChanged && "error handling",
            ]
              .filter(Boolean)
              .join(", ")}
          </p>
        ) : null}
        {p.schedule && (
          <p className="text-xs">
            <Badge>Schedule</Badge> {p.schedule.text}
          </p>
        )}
        {p.warnings.map((w) => (
          <p key={w.message} className="text-xs text-fg-muted">
            ⚠ {w.message}
          </p>
        ))}
        {p.needsSetup.length > 0 && (
          <p className="text-sm">
            Needs credentials:{" "}
            {p.needsSetup.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ", "}
                <Link href={`/connections/${c.id}`} className="font-mono text-accent hover:underline">
                  {c.identifier}
                </Link>
              </span>
            ))}
          </p>
        )}
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-fg-muted">Show the definition</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
          {JSON.stringify(p.definition, null, 2)}
        </pre>
      </details>

      {open && canBuild && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await acceptChangeAction(p.id);
                if (r.error) setError(r.error);
                else if (r.integrationId) router.push(`/integrations/${r.integrationId}?fromAi=1`);
              })
            }
          >
            <Check aria-hidden /> {p.editsExisting ? "Apply changes" : "Create integration"}
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await rejectChangeAction(p.id);
                if (r.error) setError(r.error);
                router.refresh();
              })
            }
          >
            <X aria-hidden /> Discard
          </Button>
        </div>
      )}
      {p.status === "accepted" && p.resultIntegrationId && (
        <Link
          href={`/integrations/${p.resultIntegrationId}`}
          className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline"
        >
          Open the integration <ExternalLink className="size-3.5" aria-hidden />
        </Link>
      )}
      {p.status === "stale" && (
        <p className="mt-3 text-xs text-fg-muted">Replaced by a newer proposal, or the integration changed since.</p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
