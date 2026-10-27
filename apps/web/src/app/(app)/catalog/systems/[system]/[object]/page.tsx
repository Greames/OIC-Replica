import { can, getSemanticGraph, listObjectBindings, listProposals } from "@oicr/db";
import { PLATFORM_OBJECTS } from "@oicr/semantic";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { BindingTable } from "./binding-table";
import { ObjectSettings } from "./object-settings";
import { ProposalReview } from "./proposal-review";

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export default async function ObjectPage({ params }: { params: Promise<{ system: string; object: string }> }) {
  const p = await params;
  const system = decode(p.system);
  const object = decode(p.object);
  const viewer = await requireViewer();
  const [graph, proposals, rows] = await Promise.all([
    getSemanticGraph(db, viewer),
    listProposals(db, viewer, { system, object }),
    listObjectBindings(db, viewer, system, object),
  ]);
  const o = graph.object(system, object);
  if (!o) notFound();
  const entity = graph.entity(o.entity)!;
  const sys = graph.system(system);
  const canBuild = can(viewer.role, "build");
  const seed = PLATFORM_OBJECTS.find((x) => x.system === system && x.object === object);
  const switchedOff = rows.filter((r) => r.attribute === null).map((r) => r.field);
  const open = proposals.filter((x) => x.status === "open");

  return (
    <>
      <PageHeader
        title={o.label}
        description={
          o.description || `${sys?.label ?? system} ${sys?.objectKind ?? "object"} bound to ${entity.label}.`
        }
      />
      <p className="-mt-4 mb-6 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        <Link href="/catalog" className="text-accent hover:underline">
          Semantic catalog
        </Link>
        / <span className="font-mono">{system}</span> / <span className="font-mono">{object}</span> →{" "}
        <Link href={`/catalog/entities/${entity.name}`} className="text-accent hover:underline">
          {entity.name}
        </Link>
        <Badge>{o.origin === "platform" ? "platform" : seed ? "customised" : "workspace"}</Badge>
      </p>

      {open.map((proposal) => (
        <ProposalReview
          key={proposal.id}
          canBuild={canBuild}
          proposal={{
            id: proposal.id,
            system,
            object,
            entity: proposal.entity,
            entityConfidence: proposal.entityConfidence,
            reasoning: proposal.reasoning,
            model: proposal.model,
            createdAt: proposal.createdAt.toISOString(),
            items: proposal.items,
            unmapped: proposal.unmapped,
            dropped: proposal.dropped,
          }}
          objectEntity={o.entity}
          attributes={entity.attributes.map((a) => ({ name: a.name, label: a.label }))}
        />
      ))}

      <Card className="mb-6 p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">Field bindings</h2>
          <span className="text-sm text-fg-muted">
            {o.fields.length} of {entity.attributes.length} {entity.name} attributes bound
          </span>
        </div>
        <BindingTable
          system={system}
          object={object}
          canBuild={canBuild}
          attributes={entity.attributes.map((a) => ({ name: a.name, label: a.label, type: a.type }))}
          fields={o.fields.map((f) => ({
            field: f.field,
            attribute: f.attribute,
            read: f.read ?? "",
            write: f.write ?? "",
            readOnly: !!f.readOnly,
            origin: f.origin,
            confidence: f.confidence ?? null,
            evidence: f.evidence ?? null,
            hasPlatform: !!seed?.fields.some((s) => s.field === f.field),
          }))}
          switchedOff={switchedOff}
        />
      </Card>

      <Card className="mb-6 p-5">
        <h2 className="mb-2 font-medium">Use it in an integration</h2>
        <p className="mb-3 text-sm text-fg-muted">
          Expressions read and write {object} records through the catalog. Activation pins these bindings into the
          integration; later changes reach it when it is activated again.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">
          {`$toSemantic($source, "${system}", "${object}")      → ${entity.name} records\n$fromSemantic($${entity.name.charAt(0).toLowerCase()}${entity.name.slice(1)}, "${system}", "${object}")\n$translate($source, "${system}", "${object}", "<to system>", "<to object>")`}
        </pre>
      </Card>

      {canBuild && (
        <Card className="mb-6 p-5">
          <h2 className="mb-3 font-medium">Object</h2>
          <ObjectSettings
            system={system}
            object={object}
            entity={o.entity}
            entities={graph.entities().map((e) => e.name)}
            removable={o.origin === "tenant" || rows.length > 0}
            platform={!!seed}
          />
        </Card>
      )}

      {proposals.some((x) => x.status === "closed") && (
        <Card className="p-5">
          <h2 className="mb-3 font-medium">Earlier AI proposals</h2>
          <ul className="space-y-1 text-sm text-fg-muted">
            {proposals
              .filter((x) => x.status === "closed")
              .map((x) => (
                <li key={x.id}>
                  {x.createdAt.toLocaleString()} · {x.model} ·{" "}
                  {x.items.filter((i) => i.decision === "approved" || i.decision === "auto_approved").length} applied,{" "}
                  {x.items.filter((i) => i.decision === "rejected").length} rejected
                </li>
              ))}
          </ul>
        </Card>
      )}
    </>
  );
}
