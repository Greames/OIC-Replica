import { can, listIntegrations, listProjects } from "@oicr/db";
import { Workflow } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { NewIntegrationForm } from "./new-integration-form";

export const metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  const viewer = await requireViewer();
  const [rows, projects] = await Promise.all([listIntegrations(db, viewer), listProjects(db, viewer)]);
  return (
    <>
      <PageHeader title="Integrations" description="Flows that move data between your systems." />
      {can(viewer.role, "build") &&
        (projects.length === 0 ? (
          <Card className="mb-6 p-5 text-sm">
            Integrations live in a project.{" "}
            <Link href="/projects" className="font-medium text-accent hover:underline">
              Create a project first
            </Link>
            .
          </Card>
        ) : (
          <Card className="mb-6 p-5">
            <NewIntegrationForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
          </Card>
        ))}
      {rows.length === 0 ? (
        <EmptyState icon={<Workflow />} title="No integrations yet">
          Create one above. You will describe it in plain English once the AI builder arrives; for now, start from a
          template.
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-fg-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Project</th>
                <th className="px-5 py-2.5 font-medium">Starts</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((i) => (
                <tr key={i.id} className="hover:bg-muted">
                  <td className="px-5 py-3">
                    <Link href={`/integrations/${i.id}`} className="font-medium hover:underline">
                      {i.name}
                    </Link>
                    <div className="font-mono text-xs text-fg-muted">
                      {i.identifier} · {i.version}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-fg-muted">{i.projectName}</td>
                  <td className="px-5 py-3 text-fg-muted">{i.style === "scheduled" ? "Schedule" : "HTTP call"}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={i.status} />
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
