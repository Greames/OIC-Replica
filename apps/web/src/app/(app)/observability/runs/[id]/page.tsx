import { getInstance, NotFoundError } from "@oicr/db";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDuration } from "@/components/runs-table";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";
import { AutoRefresh } from "./auto-refresh";

function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <div className="mb-1 text-xs text-fg-muted">{label}</div>
      <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const run = await getInstance(db, viewer, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const live = run.status === "queued" || run.status === "running";

  return (
    <>
      <AutoRefresh active={live} />
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-sm text-fg-muted">
        <Link href="/observability" className="hover:underline">
          Runs
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <Link href={`/integrations/${run.integrationId}`} className="hover:underline">
          {run.integrationName}
        </Link>
      </nav>
      <PageHeader
        title={`Run of ${run.integrationName}`}
        description={`${run.createdAt.toLocaleString()} · ${run.triggerKind} · ${formatDuration(run.durationMs)}`}
        actions={<StatusBadge status={run.status} />}
      />

      {run.errorMessage && (
        <Card role="alert" className="mb-6 border-danger/40 bg-danger/5 p-4 text-sm">
          <div className="font-medium text-danger">{run.errorCode}</div>
          <div className="mt-1">{run.errorMessage}</div>
        </Card>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-4 text-sm">
          <div className="text-xs text-fg-muted">Business ID</div>
          <div className="mt-1 font-mono">{run.primaryBusinessId ?? "—"}</div>
        </Card>
        <Card className="p-4 text-sm">
          <div className="text-xs text-fg-muted">Steps run</div>
          <div className="mt-1">{run.steps.length}</div>
        </Card>
        <Card className="p-4 text-sm">
          <div className="text-xs text-fg-muted">Payload tracing</div>
          <div className="mt-1">{run.tracingLevel}</div>
        </Card>
      </div>

      <Payload label="Trigger input" value={run.input} />
      {run.output !== null && (
        <div className="mt-4">
          <Payload label="Response" value={run.output} />
        </div>
      )}

      <h2 className="mt-8 mb-3 font-medium">Activity</h2>
      {run.steps.length === 0 ? (
        <Card className="p-5 text-sm text-fg-muted">{live ? "Waiting for the first step…" : "No steps ran."}</Card>
      ) : (
        <ol className="flex flex-col gap-2">
          {run.steps.map((s) => (
            <li key={s.id}>
              <details className="group rounded-xl border border-border bg-panel" open={s.status === "failed"}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="w-6 text-right font-mono text-xs text-fg-muted">{s.seq}</span>
                  <span className="font-mono font-medium">{s.stepId}</span>
                  <Badge>{s.stepType}</Badge>
                  {s.iteration !== null && <span className="text-xs text-fg-muted">item {s.iteration + 1}</span>}
                  <span className="min-w-0 flex-1 truncate text-fg-muted">{s.message}</span>
                  <span className="text-xs text-fg-muted">
                    {formatDuration(s.endedAt.getTime() - s.startedAt.getTime())}
                  </span>
                  <StatusBadge status={s.status} />
                </summary>
                <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
                  {s.message && <p className="text-sm">{s.message}</p>}
                  <Payload label="Input" value={s.input} />
                  <Payload label="Output" value={s.output} />
                  {s.input === null && s.output === null && !s.message && (
                    <p className="text-xs text-fg-muted">No payload kept (tracing level {run.tracingLevel}).</p>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
