import { can, catalogPath, getSemanticGraph, listProposals } from "@oicr/db";
import { CATALOG_VERSION } from "@oicr/semantic";
import { Network, Sparkles } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { NewEntityForm } from "./new-entity-form";

export const metadata = { title: "Semantic catalog" };

export default async function CatalogPage() {
  const viewer = await requireViewer();
  const [graph, open] = await Promise.all([
    getSemanticGraph(db, viewer),
    listProposals(db, viewer, { status: "open" }),
  ]);
  const canBuild = can(viewer.role, "build");
  const entities = graph.entities();
  const systems = graph.systems();

  return (
    <>
      <PageHeader
        title="Semantic catalog"
        description={`Business entities, and how each system's tables and resources map to them. Integrations read and write through it with $toSemantic, $fromSemantic and $translate. Platform catalog ${CATALOG_VERSION}.`}
        actions={
          canBuild && (
            <Link href="/catalog/discover" className={buttonVariants()}>
              <Sparkles aria-hidden /> Bind a system object
            </Link>
          )
        }
      />

      {open.length > 0 && (
        <Card className="mb-6 border-accent/40 p-5">
          <h2 className="mb-3 font-medium">Waiting for review</h2>
          <ul className="space-y-2 text-sm">
            {open.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-2">
                <Link href={catalogPath(p.system, p.object)} className="font-mono text-accent hover:underline">
                  {p.system} / {p.object}
                </Link>
                <span className="text-fg-muted">
                  {p.items.filter((i) => i.decision === "pending").length} AI binding(s) for {p.entity}, proposed{" "}
                  {p.createdAt.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {graph.problems.length > 0 && (
        <Card className="mb-6 border-danger/40 p-5">
          <h2 className="mb-2 font-medium">Bindings that do not apply</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            {graph.problems.map((p) => (
              <li key={`${p.system}/${p.object}/${p.field}/${p.message}`}>{p.message}</li>
            ))}
          </ul>
        </Card>
      )}

      <h2 className="mb-3 text-lg font-medium">Systems</h2>
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {systems.map((s) => {
          const objects = graph.objects({ system: s.id });
          return (
            <Card key={s.id} className="p-5">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{s.label}</h3>
                {s.label !== s.id && <Badge className="font-mono">{s.id}</Badge>}
                {s.origin === "tenant" && <Badge>workspace</Badge>}
              </div>
              {s.description && <p className="mb-3 text-sm text-fg-muted">{s.description}</p>}
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {objects.map((o) => (
                    <tr key={o.object}>
                      <td className="py-1.5 pr-3">
                        <Link href={catalogPath(o.system, o.object)} className="font-mono hover:underline">
                          {o.object}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-3 text-fg-muted">{o.entity}</td>
                      <td className="py-1.5 text-right text-xs text-fg-muted tabular-nums">
                        {o.fields.length} field{o.fields.length === 1 ? "" : "s"}
                        {o.fields.some((f) => f.origin === "tenant") && " · customised"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-medium">Entities</h2>
      </div>
      <Card className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-fg-muted">
            <tr>
              <th className="px-5 py-2.5 font-medium">Entity</th>
              <th className="px-5 py-2.5 font-medium">Attributes</th>
              <th className="px-5 py-2.5 font-medium">Bound in</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entities.map((e) => {
              const bound = graph.objects({ entity: e.name }).filter((o) => o.fields.length > 0);
              return (
                <tr key={e.name} className="hover:bg-muted">
                  <td className="px-5 py-3">
                    <Link href={`/catalog/entities/${e.name}`} className="font-medium hover:underline">
                      {e.name}
                    </Link>
                    {e.origin === "tenant" && <Badge className="ml-2">workspace</Badge>}
                    {e.extended?.length ? <Badge className="ml-2">+{e.extended.length} added</Badge> : null}
                    <div className="text-xs text-fg-muted">{e.description}</div>
                  </td>
                  <td className="px-5 py-3 tabular-nums">{e.attributes.length}</td>
                  <td className="px-5 py-3 text-xs text-fg-muted">
                    {[...new Set(bound.map((o) => graph.system(o.system)?.label ?? o.system))].join(", ") || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {canBuild && (
        <Card className="p-5">
          <h3 className="mb-3 flex items-center gap-2 font-medium">
            <Network className="size-4" aria-hidden /> New entity
          </h3>
          <NewEntityForm />
        </Card>
      )}
    </>
  );
}
