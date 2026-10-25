import { adapters } from "@oicr/adapters";
import { listProjects } from "@oicr/db";
import { PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { ConnectionForm } from "../connection-form";

export const metadata = { title: "New connection" };

const COMING = ["SOAP", "SFTP", "PostgreSQL", "MySQL", "Email"];

export default async function NewConnectionPage() {
  const viewer = await requireViewer();
  const projects = await listProjects(db, viewer);
  const rest = adapters.rest!;
  return (
    <>
      <PageHeader title="New connection" description={`${rest.name}: ${rest.description}`} />
      <p className="mb-6 text-sm text-fg-muted">More adapters are on the way: {COMING.join(", ")}.</p>
      <ConnectionForm
        adapter={{ id: rest.id, name: rest.name, fields: rest.fields, authTypes: rest.authTypes, roles: rest.roles }}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      />
    </>
  );
}
