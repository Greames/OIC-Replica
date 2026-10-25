import { randomBytes } from "node:crypto";
import { can, listChannels, recentDeliveries } from "@oicr/db";
import { BellRing } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { Badge, Card, EmptyState } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { ChannelForm } from "./channel-form";
import { ChannelActions } from "./channel-row";

export const metadata = { title: "Notifications" };

const KIND_LABEL = { slack: "Slack", telegram: "Telegram", email: "Email", webhook: "Webhook" } as const;

function filterLabel(types: string[], min: string): string {
  if (types.length === 1 && types[0] === "instance.failed") return "failed runs";
  if (types.length === 1 && types[0] === "instance.*") return "every run";
  if (min === "warning") return "warnings and failures";
  if (min === "error") return "failures";
  return "every update";
}

export default async function NotificationsPage() {
  const viewer = await requireViewer();
  if (!can(viewer.role, "admin"))
    return <Card className="p-5 text-sm text-fg-muted">Only admins manage notification channels.</Card>;
  const channels = await listChannels(db, viewer);
  const recent = Object.fromEntries(
    await Promise.all(channels.map(async (c) => [c.id, await recentDeliveries(db, viewer, c.id, 5)] as const)),
  );

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-fg-muted">
        Updates (runs, activations, AI proposals, connection tests) go to these channels as they happen. See them all on{" "}
        <Link href="/activity" className="text-accent hover:underline">
          Activity
        </Link>
        . For Hermes Agent, use the{" "}
        <Link href="/settings/hermes" className="text-accent hover:underline">
          Hermes setup
        </Link>
        .
      </p>

      {channels.length === 0 ? (
        <EmptyState icon={<BellRing />} title="No channels yet">
          Add Slack, Telegram, email, or a webhook below.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Channels">
          {channels.map((c) => (
            <li key={c.id}>
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{c.name}</h3>
                      <Badge>{KIND_LABEL[c.kind]}</Badge>
                      {!c.enabled && <Badge>paused</Badge>}
                    </div>
                    <p className="mt-1 truncate text-sm text-fg-muted">
                      {c.target} · {filterLabel(c.eventTypes, c.minSeverity)}
                    </p>
                    {c.lastError ? (
                      <p className="mt-1 text-xs text-danger">Last error: {c.lastError}</p>
                    ) : c.lastDeliveredAt ? (
                      <p className="mt-1 text-xs text-fg-muted">Last delivered {c.lastDeliveredAt.toLocaleString()}</p>
                    ) : null}
                  </div>
                  <ChannelActions id={c.id} enabled={c.enabled} />
                </div>
                {recent[c.id]?.length ? (
                  <details>
                    <summary className="cursor-pointer text-xs text-fg-muted">Recent deliveries</summary>
                    <ul className="mt-2 flex flex-col gap-1 text-xs">
                      {recent[c.id]!.map((d) => (
                        <li key={d.id} className="flex items-center gap-2">
                          <StatusBadge
                            status={d.status === "sent" ? "succeeded" : d.status === "failed" ? "failed" : "queued"}
                          />
                          <span className="min-w-0 flex-1 truncate">{d.summary}</span>
                          {d.lastError && d.status !== "sent" && (
                            <span className="truncate text-danger" title={d.lastError}>
                              {d.lastError}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Card className="p-5">
        <h2 className="mb-4 font-medium">Add a channel</h2>
        <ChannelForm secret={randomBytes(24).toString("base64url")} />
      </Card>
    </div>
  );
}
