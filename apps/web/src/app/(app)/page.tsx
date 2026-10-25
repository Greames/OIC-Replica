import { listProjects } from "@oicr/db";
import { ArrowRight, FolderKanban, Sparkles } from "lucide-react";
import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";

export default async function HomePage() {
  const viewer = await requireViewer();
  const projects = (await listProjects(db, viewer)).slice(0, 5);

  return (
    <>
      <PageHeader
        title={`Hi, ${viewer.name.split(" ")[0]}`}
        description="Describe an integration, review what the AI builds, and turn it on."
      />

      <Card className="relative overflow-hidden p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-lg bg-accent/10 p-2 text-accent">
            <Sparkles className="size-5" aria-hidden />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Build with AI</h2>
              <Badge>Phase 2</Badge>
            </div>
            <p className="mt-1 text-sm text-fg-muted">
              “Every 15 minutes, send new orders from our Postgres to the shop API, and email me if one fails.”
            </p>
            <textarea
              disabled
              placeholder="Describe the integration you want…"
              className="mt-4 min-h-20 w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm"
            />
          </div>
        </div>
      </Card>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="font-medium">Recent projects</h2>
        <Link href="/projects" className="flex items-center gap-1 text-sm text-accent hover:underline">
          All projects <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      {projects.length === 0 ? (
        <Card className="mt-3 flex items-center gap-3 p-5 text-sm text-fg-muted">
          <FolderKanban className="size-5" aria-hidden />
          No projects yet.
          <Link href="/projects" className="font-medium text-accent hover:underline">
            Create your first project
          </Link>
        </Card>
      ) : (
        <Card className="mt-3 divide-y divide-border">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="flex items-center justify-between px-5 py-3 hover:bg-muted"
            >
              <span className="font-medium">{p.name}</span>
              <span className="font-mono text-xs text-fg-muted">{p.identifier}</span>
            </Link>
          ))}
        </Card>
      )}
    </>
  );
}
