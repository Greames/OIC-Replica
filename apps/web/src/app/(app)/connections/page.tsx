import { listConnections } from "@oicr/db";
import { Cable, Plus } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";

export const metadata = { title: "Connections" };

export default async function ConnectionsPage() {
  const viewer = await requireViewer();
  const rows = await listConnections(db, viewer);
  return (
    <>
      <PageHeader
        title="Connections"
        description="Endpoints and credentials your integrations use."
        actions={
          <Link href="/connections/new" className={buttonVariants()}>
            <Plus aria-hidden /> New connection
          </Link>
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon={<Cable />} title="No connections yet">
          Connect an API so integrations can call it.
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-fg-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Identifier</th>
                <th className="px-5 py-2.5 font-medium">Adapter</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-muted">
                  <td className="px-5 py-3">
                    <Link href={`/connections/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-fg-muted">{c.identifier}</td>
                  <td className="px-5 py-3">
                    <Badge>{c.adapter.toUpperCase()}</Badge>
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
