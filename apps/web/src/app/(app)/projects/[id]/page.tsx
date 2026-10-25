import { can, getProject, listConnections, listIntegrations, NotFoundError } from "@oicr/db";
import { Cable, Workflow } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";
import { NewIntegrationForm } from "../../integrations/new-integration-form";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const project = await getProject(db, viewer, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [integrations, connections] = await Promise.all([
    listIntegrations(db, viewer, { projectId: id }),
    listConnections(db, viewer),
  ]);
  const visibleConnections = connections.filter((c) => c.projectId === id || c.projectId === null);

  return (
    <>
      <PageHeader
        title={project.name}
        description={project.description || undefined}
        actions={<Badge className="font-mono">{project.identifier}</Badge>}
      />

      {can(viewer.role, "build") && (
        <Card className="mb-6 p-5">
          <NewIntegrationForm projects={[{ id: project.id, name: project.name }]} defaultProjectId={project.id} />
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-medium">
            <Workflow className="size-4 text-fg-muted" aria-hidden /> Integrations
          </h2>
          <Card className="divide-y divide-border">
            {integrations.length === 0 && <p className="p-5 text-sm text-fg-muted">None yet.</p>}
            {integrations.map((i) => (
              <Link
                key={i.id}
                href={`/integrations/${i.id}`}
                className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{i.name}</div>
                  <div className="font-mono text-xs text-fg-muted">{i.identifier}</div>
                </div>
                <StatusBadge status={i.status} />
              </Link>
            ))}
          </Card>
        </section>
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-medium">
            <Cable className="size-4 text-fg-muted" aria-hidden /> Connections it can use
          </h2>
          <Card className="divide-y divide-border">
            {visibleConnections.length === 0 && (
              <p className="p-5 text-sm text-fg-muted">
                None yet.{" "}
                <Link href="/connections/new" className="text-accent hover:underline">
                  Add one
                </Link>
                .
              </p>
            )}
            {visibleConnections.map((c) => (
              <Link
                key={c.id}
                href={`/connections/${c.id}`}
                className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted"
              >
                <span className="truncate font-mono text-sm">{c.identifier}</span>
                <StatusBadge status={c.status} />
              </Link>
            ))}
          </Card>
        </section>
      </div>
    </>
  );
}
