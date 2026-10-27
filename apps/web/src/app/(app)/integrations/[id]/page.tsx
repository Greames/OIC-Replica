import {
  can,
  connectionIndex,
  describeSchedule,
  getIntegration,
  getSamples,
  listConnections,
  listInstances,
  listLookups,
  NotFoundError,
  orgs,
} from "@oicr/db";
import { FlowDoc, type Issue } from "@oicr/flow-schema";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EditWithAi } from "@/components/build-with-ai";
import { FlowEditor } from "@/components/canvas/flow-editor";
import { RunsTable } from "@/components/runs-table";
import { StatusBadge } from "@/components/status-badge";
import { Card, PageHeader } from "@/components/ui/card";
import { aiEnabled } from "@/lib/ai";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";
import { templatesFor } from "@/lib/templates";
import { cn } from "@/lib/utils";
import { DefinitionEditor } from "./definition-editor";
import { Lifecycle } from "./lifecycle";
import { ScheduleForm } from "./schedule-form";
import { TriggerPanel } from "./trigger-panel";

export default async function IntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fromAi?: string; view?: string }>;
}) {
  const { id } = await params;
  const { fromAi, view } = await searchParams;
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const integration = await getIntegration(db, viewer, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [runs, conns, connRows, [org], samples, lookupRows] = await Promise.all([
    listInstances(db, viewer, { integrationId: id, limit: 10 }),
    connectionIndex(db, viewer.orgId),
    listConnections(db, viewer),
    db.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, viewer.orgId)),
    getSamples(db, viewer, id),
    listLookups(db, viewer),
  ]);

  const def = integration.definition as { trigger?: { type?: string; method?: string; path?: string; sync?: boolean } };
  const isHttp = def.trigger?.type === "http";
  const active = integration.status === "active";
  const canBuild = can(viewer.role, "build");
  const base = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const triggerPath = def.trigger?.path && def.trigger.path !== "/" ? def.trigger.path : "";
  const parsed = FlowDoc.safeParse(integration.definition);
  const showCanvas = view !== "json" && parsed.success;
  const invokeConns = Object.entries(conns)
    .filter(([, c]) => c.role !== "trigger")
    .map(([k]) => k);

  return (
    <>
      <PageHeader
        title={integration.name}
        description={`${integration.identifier} · ${integration.version} · ${integration.style === "scheduled" ? "runs on a schedule" : "runs when called"}`}
        actions={
          <div className="flex items-center gap-2">
            {canBuild && aiEnabled() && <EditWithAi integrationId={id} />}
            <StatusBadge status={integration.status} />
          </div>
        }
      />
      {fromAi && (
        <p role="status" className="-mt-2 mb-6 rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
          Built by the AI builder. Check the connections it uses have credentials and pass their test, then activate.
        </p>
      )}
      <p className="-mt-4 mb-6 text-sm text-fg-muted">
        In{" "}
        <Link href={`/projects/${integration.projectId}`} className="text-accent hover:underline">
          {integration.projectName}
        </Link>
      </p>

      <Card className="mb-6 p-5">
        <Lifecycle
          id={id}
          status={integration.status}
          tracingLevel={integration.tracingLevel}
          canOperate={can(viewer.role, "operate")}
          needsPayload={isHttp && def.trigger?.sync === true}
        />
        {!active && integration.status !== "configured" && (
          <p className="mt-3 text-sm text-fg-muted">
            {(integration.validationErrors as Issue[]).length > 0
              ? "Fix the problems under Definition, save, then activate."
              : "Add steps under Definition (or start from a template), save, then activate."}
          </p>
        )}
      </Card>

      {integration.style === "scheduled" && (
        <Card className="mb-6 p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-medium">Schedule</h2>
            {integration.schedule && (
              <span className="text-sm text-fg-muted">
                {describeSchedule(integration.schedule)}
                {active &&
                  integration.schedule.nextRunAt &&
                  ` · next run ${integration.schedule.nextRunAt.toLocaleString()}`}
              </span>
            )}
          </div>
          <ScheduleForm id={id} initial={integration.schedule} disabled={!canBuild} />
        </Card>
      )}

      {isHttp && active && canBuild && org && (
        <Card className="mb-6 p-5">
          <h2 className="mb-4 font-medium">Call it</h2>
          <TriggerPanel
            id={id}
            url={`${base}/t/${org.slug}/${integration.identifier}${triggerPath}`}
            method={def.trigger?.method ?? "POST"}
            hint={integration.triggerTokenHint}
          />
        </Card>
      )}

      <Card className="mb-6 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Definition</h2>
          <nav aria-label="Definition view" className="flex rounded-lg border border-border p-0.5 text-sm">
            {(["canvas", "json"] as const).map((v) => (
              <Link
                key={v}
                href={`/integrations/${id}${v === "json" ? "?view=json" : ""}`}
                aria-current={showCanvas === (v === "canvas") ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1",
                  showCanvas === (v === "canvas") ? "bg-muted font-medium" : "text-fg-muted hover:text-fg",
                )}
              >
                {v === "canvas" ? "Canvas" : "JSON"}
              </Link>
            ))}
          </nav>
        </div>
        {showCanvas && parsed.success ? (
          <FlowEditor
            integrationId={id}
            initial={parsed.data}
            hash={integration.definitionHash}
            locked={active || !canBuild}
            connections={connRows.map((c) => ({
              identifier: c.identifier,
              role: c.role,
              status: c.status,
              adapter: c.adapter,
            }))}
            samples={samples}
            lookups={lookupRows.map((l) => ({ name: l.name, domains: l.domains }))}
          />
        ) : (
          <>
            {!parsed.success && (
              <p className="mb-3 text-sm text-fg-muted">
                The canvas needs a definition with a valid shape. Fix the problems below, save, then switch to Canvas.
              </p>
            )}
            <DefinitionEditor
              id={id}
              initial={integration.definition}
              hash={integration.definitionHash}
              initialErrors={integration.validationErrors as Issue[]}
              locked={active || !canBuild}
              templates={templatesFor(integration.style, invokeConns)}
            />
          </>
        )}
      </Card>

      <h2 className="mb-3 font-medium">Recent runs</h2>
      <RunsTable runs={runs.items} showIntegration={false} />
    </>
  );
}
