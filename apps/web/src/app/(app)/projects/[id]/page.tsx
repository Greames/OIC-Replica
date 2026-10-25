import { getProject, NotFoundError } from "@oicr/db";
import { Cable, Table2, Workflow } from "lucide-react";
import { notFound } from "next/navigation";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const project = await getProject(db, viewer, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });

  const sections = [
    { icon: Workflow, title: "Integrations", phase: 1, text: "Flows that move data between your systems." },
    { icon: Cable, title: "Connections", phase: 1, text: "Endpoints and credentials your integrations use." },
    { icon: Table2, title: "Lookups", phase: 5, text: "Value maps between systems, like country codes." },
  ];

  return (
    <>
      <PageHeader
        title={project.name}
        description={project.description || undefined}
        actions={<Badge className="font-mono">{project.identifier}</Badge>}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        {sections.map(({ icon: Icon, title, phase, text }) => (
          <Card key={title} className="p-5">
            <div className="flex items-center justify-between">
              <Icon className="size-5 text-fg-muted" aria-hidden />
              <Badge>Phase {phase}</Badge>
            </div>
            <h2 className="mt-3 font-medium">{title}</h2>
            <p className="mt-1 text-sm text-fg-muted">{text}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
