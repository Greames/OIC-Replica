import { listEvents } from "@oicr/db";
import { BellRing } from "lucide-react";
import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { cn } from "@/lib/utils";

export const metadata = { title: "Activity" };

function ago(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return d.toLocaleDateString();
}

export default async function ActivityPage() {
  const viewer = await requireViewer();
  const { events } = await listEvents(db, viewer, { newestFirst: true, limit: 100 });
  return (
    <>
      <PageHeader
        title="Activity"
        description="Everything that happens in this workspace, live. The same updates go to your notification channels and to Hermes Agent."
        actions={
          <Link href="/settings/notifications" className="text-sm text-accent hover:underline">
            Notification channels
          </Link>
        }
      />
      {events.length === 0 ? (
        <EmptyState icon={<BellRing />} title="Nothing yet">
          Runs, activations, AI proposals and connection tests show up here as they happen.
        </EmptyState>
      ) : (
        <Card className="divide-y divide-border" aria-label="Activity feed">
          {events.map((e) => (
            <div key={e.id} className="flex items-start gap-3 px-5 py-3 text-sm" data-event-type={e.type}>
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  e.severity === "error"
                    ? "bg-danger"
                    : e.severity === "warning"
                      ? "bg-amber-500"
                      : e.type === "instance.succeeded"
                        ? "bg-success"
                        : "bg-fg-muted/40",
                )}
              />
              <div className="min-w-0 flex-1">
                {e.path ? (
                  <Link href={e.path} className="break-words hover:underline">
                    {e.summary}
                  </Link>
                ) : (
                  <span className="break-words">{e.summary}</span>
                )}
                <div className="mt-0.5 font-mono text-[11px] text-fg-muted">
                  {e.type} · #{e.id}
                </div>
              </div>
              <time
                dateTime={e.createdAt.toISOString()}
                className="shrink-0 text-xs text-fg-muted"
                title={e.createdAt.toLocaleString()}
              >
                {ago(e.createdAt)}
              </time>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
