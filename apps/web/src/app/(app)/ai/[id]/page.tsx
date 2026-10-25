import { can, describeSchedule, getAiSession, getIntegration, listConnections, NotFoundError } from "@oicr/db";
import type { FlowDiff } from "@oicr/flow-schema";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/card";
import { aiEnabled } from "@/lib/ai";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";
import { toChatItems } from "@/lib/transcript";
import { Chat } from "./chat";
import type { ProposalView } from "./proposal-card";

export const metadata = { title: "AI builder" };

export default async function AiSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ send?: string }>;
}) {
  const { id } = await params;
  const { send } = await searchParams;
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const { session, messages, changes } = await getAiSession(db, viewer, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [integration, connections] = await Promise.all([
    session.integrationId ? getIntegration(db, viewer, session.integrationId).catch(() => null) : null,
    listConnections(db, viewer),
  ]);
  const unconfigured = connections.filter((c) => c.status !== "configured");

  const proposals: Record<string, ProposalView> = {};
  for (const c of changes) {
    const used = new Set<string>();
    JSON.stringify(c.proposedDefinition, (k, v) => {
      if (k === "connection" && typeof v === "string") used.add(v);
      return v;
    });
    proposals[c.id] = {
      id: c.id,
      name: c.name,
      summary: c.summary,
      status: c.status,
      diff: c.diff as FlowDiff,
      schedule: c.schedule && { ...c.schedule, text: describeSchedule(c.schedule) },
      warnings: c.warnings as { message: string }[],
      definition: c.proposedDefinition,
      editsExisting: c.integrationId !== null,
      resultIntegrationId: c.resultIntegrationId,
      needsSetup: unconfigured
        .filter((u) => used.has(u.identifier))
        .map((u) => ({ id: u.id, identifier: u.identifier })),
    };
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={integration ? `AI builder · ${integration.name}` : "AI builder"}
        description={
          integration
            ? "Describe changes; review them before they apply."
            : "Describe the integration; review it before it is created."
        }
      />
      {integration && (
        <p className="-mt-4 mb-6 text-sm">
          <Link href={`/integrations/${integration.id}`} className="text-accent hover:underline">
            Back to {integration.name}
          </Link>
        </p>
      )}
      {!aiEnabled() && (
        <p role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          The AI builder is not set up on this server. Set <code>ANTHROPIC_API_KEY</code> and restart.
        </p>
      )}
      <Chat
        sessionId={session.id}
        initialItems={toChatItems(messages, session.pending?.otherResults ?? [])}
        proposals={proposals}
        status={session.status}
        lastError={session.lastError}
        initialSend={send ?? null}
        canBuild={can(viewer.role, "build") && aiEnabled()}
        placeholder={
          integration ? "e.g. retry the send step 3 times and email me when it fails" : "Describe the integration…"
        }
      />
    </div>
  );
}
