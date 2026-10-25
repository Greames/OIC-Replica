import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";

export interface RunRow {
  id: string;
  status: string;
  triggerKind: string;
  primaryBusinessId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  durationMs: number | null;
  integrationName: string;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function RunsTable({ runs, showIntegration = true }: { runs: RunRow[]; showIntegration?: boolean }) {
  if (runs.length === 0) return <Card className="p-5 text-sm text-fg-muted">No runs yet.</Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-fg-muted">
          <tr>
            <th className="px-5 py-2.5 font-medium">Started</th>
            {showIntegration && <th className="px-5 py-2.5 font-medium">Integration</th>}
            <th className="px-5 py-2.5 font-medium">Business ID</th>
            <th className="px-5 py-2.5 font-medium">Status</th>
            <th className="px-5 py-2.5 font-medium">Took</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((r) => (
            <tr key={r.id} className="hover:bg-muted">
              <td className="px-5 py-3">
                <Link href={`/observability/runs/${r.id}`} className="font-medium hover:underline">
                  <time dateTime={r.createdAt.toISOString()}>{r.createdAt.toLocaleString()}</time>
                </Link>
                <div className="text-xs text-fg-muted">{r.triggerKind}</div>
              </td>
              {showIntegration && <td className="px-5 py-3">{r.integrationName}</td>}
              <td className="px-5 py-3 font-mono text-xs">{r.primaryBusinessId ?? "—"}</td>
              <td className="px-5 py-3">
                <StatusBadge status={r.status} />
                {r.errorMessage && (
                  <div className="mt-1 max-w-xs truncate text-xs text-danger" title={r.errorMessage}>
                    {r.errorMessage}
                  </div>
                )}
              </td>
              <td className="px-5 py-3 text-fg-muted">{formatDuration(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
