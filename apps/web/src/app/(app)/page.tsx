import { can, listAiSessions, listProjects } from "@oicr/db";
import { ArrowRight, FolderKanban, MessageSquare, Sparkles } from "lucide-react";
import Link from "next/link";
import { BuildWithAi } from "@/components/build-with-ai";
import { Card, PageHeader } from "@/components/ui/card";
import { aiEnabled, aiHint } from "@/lib/ai";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";

export default async function HomePage() {
  const viewer = await requireViewer();
  const [allProjects, sessions] = await Promise.all([
    listProjects(db, viewer),
    listAiSessions(db, viewer, { limit: 5 }),
  ]);
  const projects = allProjects.slice(0, 5);
  const enabled = aiEnabled();
  const canBuild = can(viewer.role, "build");

  return (
    <>
      <PageHeader
        title={`Hi, ${viewer.name.split(" ")[0]}`}
        description="Describe an integration, review what the AI builds, and turn it on."
      />

      {canBuild && (
        <Card className="p-6">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-accent/10 p-2 text-accent">
              <Sparkles className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-medium">Build with AI</h2>
              <p className="mt-1 mb-4 text-sm text-fg-muted">
                Say what should happen, in your own words. The AI asks what it needs, drafts the integration, and you
                review it before anything is created.
              </p>
              {allProjects.length === 0 ? (
                <p className="text-sm">
                  <Link href="/projects" className="font-medium text-accent hover:underline">
                    Create a project
                  </Link>{" "}
                  first; integrations live in one.
                </p>
              ) : (
                <BuildWithAi projects={allProjects.map((p) => ({ id: p.id, name: p.name }))} enabled={enabled} />
              )}
              {!enabled && <p className="mt-3 text-sm text-fg-muted">The AI builder is off. {aiHint()}</p>}
            </div>
          </div>
        </Card>
      )}

      {sessions.length > 0 && (
        <>
          <h2 className="mt-8 mb-3 font-medium">Recent AI conversations</h2>
          <Card className="divide-y divide-border">
            {sessions.map((s) => (
              <Link key={s.id} href={`/ai/${s.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-muted">
                <MessageSquare className="size-4 shrink-0 text-fg-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {s.status === "waiting" && <span className="text-xs text-accent">waiting for you</span>}
              </Link>
            ))}
          </Card>
        </>
      )}

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
