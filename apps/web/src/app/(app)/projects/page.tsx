import { can, listProjects } from "@oicr/db";
import { FolderKanban } from "lucide-react";
import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { NewProjectForm } from "./new-project-form";

export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const viewer = await requireViewer();
  const projects = await listProjects(db, viewer);

  return (
    <>
      <PageHeader title="Projects" description="A project bundles integrations, connections, lookups and libraries." />
      {can(viewer.role, "build") && (
        <Card className="mb-6 p-5">
          <NewProjectForm />
        </Card>
      )}
      {projects.length === 0 ? (
        <EmptyState icon={<FolderKanban />} title="No projects yet">
          Create one above to hold your first integration.
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-fg-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Identifier</th>
                <th className="px-5 py-2.5 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {projects.map((p) => (
                <tr key={p.id} className="hover:bg-muted">
                  <td className="px-5 py-3">
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-fg-muted">{p.identifier}</td>
                  <td className="px-5 py-3 text-fg-muted">
                    <time dateTime={p.updatedAt.toISOString()}>{p.updatedAt.toLocaleDateString()}</time>
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
