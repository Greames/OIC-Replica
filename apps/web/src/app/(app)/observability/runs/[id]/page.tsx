import { getInstance, getIntegration, listCheckpoints, listRejects, NotFoundError } from "@oicr/db";
import { FlowDoc } from "@oicr/flow-schema";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { StepStatus } from "@/components/canvas/canvas";
import { formatDuration } from "@/components/runs-table";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";
import { AutoRefresh } from "./auto-refresh";
import { RunCanvas } from "./run-canvas";

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
  const [pipelines, rejects] = await Promise.all([
    listCheckpoints(db, viewer, id),
    listRejects(db, viewer, id, { limit: 50 }),
  ]);
  const integration = await getIntegration(db, viewer, run.integrationId).catch(() => null);
  const doc = integration ? FlowDoc.safeParse(integration.definition) : null;
  const sameVersion = integration?.definitionHash === run.definitionHash;
  const statuses: Record<string, StepStatus> = {};
  for (const s of run.steps) {
    const cur = statuses[s.stepId];
    const status =
      cur?.status === "failed" || s.status === "failed"
        ? "failed"
        : cur?.status === "succeeded" || s.status === "succeeded"
          ? "succeeded"
          : "skipped";
    statuses[s.stepId] = {
      status,
      runs: (cur?.runs ?? 0) + 1,
      failed: (cur?.failed ?? 0) + (s.status === "failed" ? 1 : 0),
    };
  }

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

      {pipelines.length > 0 && (
        <section aria-label="Pipelines" className="mb-6">
          <h2 className="mb-3 flex flex-wrap items-baseline gap-2 font-medium">
            Pipelines
            {run.attempts > 1 && (
              <span className="text-xs font-normal text-fg-muted">
                Resumed {run.attempts - 1} time(s) from its checkpoints after the batch engine stopped.
              </span>
            )}
          </h2>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-fg-muted">
                <tr>
                  {["Step", "Status", "Read", "Written", "Skipped", "Rejected", "Chunks"].map((h) => (
                    <th key={h} className="px-4 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums">
                {pipelines.map((p) => (
                  <tr key={p.stepId}>
                    <td className="px-4 py-2 font-mono">{p.stepId}</td>
                    <td className="px-4 py-2">
                      <Badge>{p.status === "done" ? "finished" : live ? "running" : "stopped"}</Badge>
                    </td>
                    <td className="px-4 py-2">{p.read.toLocaleString()}</td>
                    <td className="px-4 py-2">{p.written.toLocaleString()}</td>
                    <td className="px-4 py-2">{p.filtered.toLocaleString()}</td>
                    <td className={`px-4 py-2 ${p.rejected ? "text-danger" : ""}`}>{p.rejected.toLocaleString()}</td>
                    <td className="px-4 py-2">{p.chunks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {rejects.length > 0 && (
            <details className="mt-3" open={!live}>
              <summary className="cursor-pointer text-sm font-medium">
                Rejected records{rejects.length === 50 ? " (first 50)" : ""}
              </summary>
              <Card className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs text-fg-muted">
                    <tr>
                      {["Step", "Where", "Why", "Record"].map((h) => (
                        <th key={h} className="px-4 py-2 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rejects.map((r) => (
                      <tr key={r.id} className="align-top">
                        <td className="px-4 py-2 font-mono text-xs">{r.stepId}</td>
                        <td className="px-4 py-2 text-xs whitespace-nowrap">
                          {r.stage === "write" ? "target refused" : "transform"} · chunk {r.chunk + 1}, row{" "}
                          {r.rowIndex + 1}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          <div className="font-mono text-danger">{r.code}</div>
                          <div>{r.message}</div>
                        </td>
                        <td className="max-w-md px-4 py-2">
                          <pre className="overflow-x-auto font-mono text-[11px]">{JSON.stringify(r.record)}</pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </details>
          )}
        </section>
      )}

      <Payload label="Trigger input" value={run.input} />
      {run.output !== null && (
        <div className="mt-4">
          <Payload label="Response" value={run.output} />
        </div>
      )}

      {doc?.success && run.steps.length > 0 && (
        <>
          <h2 className="mt-8 mb-3 flex flex-wrap items-baseline gap-2 font-medium">
            On the integration
            {!sameVersion && (
              <span className="text-xs font-normal text-fg-muted">
                The integration changed after this run; showing its current version.
              </span>
            )}
          </h2>
          <RunCanvas doc={doc.data} statuses={statuses} />
        </>
      )}

      <h2 className="mt-8 mb-3 font-medium">Activity</h2>
      {run.steps.length === 0 ? (
        <Card className="p-5 text-sm text-fg-muted">{live ? "Waiting for the first step…" : "No steps ran."}</Card>
      ) : (
        <ol className="flex flex-col gap-2">
          {run.steps.map((s) => (
            <li key={s.id}>
              <details
                className="group rounded-xl border border-border bg-panel"
                open={s.status === "failed"}
                data-step={s.stepId}
              >
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
