import { listLookups } from "@oicr/db";
import { Plus, Table2 } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";

export const metadata = { title: "Lookups" };

export default async function LookupsPage() {
  const viewer = await requireViewer();
  const rows = await listLookups(db, viewer);
  return (
    <>
      <PageHeader
        title="Lookups"
        description="Value maps between systems, like country or status codes. Use them in any mapping with $lookupValue."
        actions={
          <Link href="/lookups/new" className={buttonVariants()}>
            <Plus aria-hidden /> New lookup
          </Link>
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon={<Table2 />} title="No lookups yet">
          A lookup has a column per system (e.g. shop, erp) and a row per value. Type it in or import a CSV.
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-fg-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Domains</th>
                <th className="px-5 py-2.5 font-medium">Rows</th>
                <th className="px-5 py-2.5 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((l) => (
                <tr key={l.id} className="hover:bg-muted">
                  <td className="px-5 py-3">
                    <Link href={`/lookups/${l.id}`} className="font-mono font-medium hover:underline">
                      {l.name}
                    </Link>
                    {l.description && <div className="text-xs text-fg-muted">{l.description}</div>}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {l.domains.map((d) => (
                        <Badge key={d}>{d}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-3 tabular-nums">{l.rowCount}</td>
                  <td className="px-5 py-3 text-xs text-fg-muted">{l.updatedAt.toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
