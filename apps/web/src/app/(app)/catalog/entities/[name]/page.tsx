import { can, catalogPath, getSemanticGraph } from "@oicr/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { AttributeForm } from "./attribute-form";

export default async function EntityPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const viewer = await requireViewer();
  const graph = await getSemanticGraph(db, viewer);
  const entity = graph.entity(name);
  if (!entity) notFound();
  const bound = graph.objects({ entity: name });

  return (
    <>
      <PageHeader title={entity.label} description={entity.description} />
      <p className="-mt-4 mb-6 text-sm text-fg-muted">
        <Link href="/catalog" className="text-accent hover:underline">
          Semantic catalog
        </Link>{" "}
        / <span className="font-mono">{entity.name}</span>
        {entity.origin === "tenant" && <Badge className="ml-2">workspace</Badge>}
      </p>

      <Card className="mb-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-fg-muted">
            <tr>
              <th className="px-5 py-2.5 font-medium">Attribute</th>
              <th className="px-5 py-2.5 font-medium">Type</th>
              <th className="px-5 py-2.5 font-medium">Meaning</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entity.attributes.map((a) => (
              <tr key={a.name}>
                <td className="px-5 py-3 align-top">
                  <span className="font-mono font-medium">{a.name}</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {a.identifier && <Badge>identifier</Badge>}
                    {a.required && <Badge>required</Badge>}
                    {entity.extended?.includes(a.name) && <Badge>added by workspace</Badge>}
                  </div>
                </td>
                <td className="px-5 py-3 align-top font-mono text-xs">
                  {a.type}
                  {a.references && <div className="text-fg-muted">→ {a.references}</div>}
                </td>
                <td className="px-5 py-3 align-top">
                  <div>{a.label}</div>
                  <div className="text-xs text-fg-muted">{a.description}</div>
                  {a.synonyms?.length ? (
                    <div className="mt-1 text-xs text-fg-muted">Also: {a.synonyms.join(", ")}</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {can(viewer.role, "build") && (
        <Card className="mb-6 p-5">
          <h2 className="mb-3 font-medium">Add an attribute</h2>
          <AttributeForm entity={entity.name} />
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-3 font-medium">Bound objects</h2>
        {bound.length === 0 ? (
          <p className="text-sm text-fg-muted">No system object is bound to {entity.name} yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {bound.map((o) => (
              <li key={`${o.system}/${o.object}`}>
                <Link href={catalogPath(o.system, o.object)} className="font-mono hover:underline">
                  {o.system} / {o.object}
                </Link>{" "}
                <span className="text-fg-muted">
                  — {o.fields.length} of {entity.attributes.length} attributes
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
