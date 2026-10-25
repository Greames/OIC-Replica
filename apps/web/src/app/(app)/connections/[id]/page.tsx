import { getAdapter } from "@oicr/adapters";
import { can, getConnection, listProjects, NotFoundError } from "@oicr/db";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";
import { deleteConnectionAction } from "../actions";
import { ConnectionForm } from "../connection-form";
import { TestButton } from "./test-button";

export default async function ConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const conn = await getConnection(db, viewer, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const adapter = getAdapter(conn.adapter);
  const projects = await listProjects(db, viewer);
  const canBuild = can(viewer.role, "build");

  return (
    <>
      <PageHeader
        title={conn.name}
        description={`${adapter.name} · ${conn.identifier}`}
        actions={<StatusBadge status={conn.status} />}
      />
      {saved && (
        <p role="status" className="mb-4 text-sm text-success">
          Saved. Test it to make sure it works.
        </p>
      )}
      <Card className="mb-6 flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="text-sm">
          <div className="font-medium">Check it works</div>
          <div className="text-fg-muted">
            {conn.status === "draft" && conn.lastTestedAt
              ? "Changed since the last test. Test it again."
              : conn.lastTestedAt
                ? conn.lastTestError
                  ? `Last test failed: ${conn.lastTestError}`
                  : `Last tested ${conn.lastTestedAt.toLocaleString()}.`
                : "Not tested yet."}
          </div>
        </div>
        {canBuild && <TestButton id={conn.id} />}
      </Card>
      {canBuild ? (
        <>
          <ConnectionForm
            adapter={{
              id: adapter.id,
              name: adapter.name,
              fields: adapter.fields,
              authTypes: adapter.authTypes,
              roles: adapter.roles,
            }}
            projects={projects.map((p) => ({ id: p.id, name: p.name }))}
            initial={{
              id: conn.id,
              name: conn.name,
              identifier: conn.identifier,
              projectId: conn.projectId,
              role: conn.role,
              authType: conn.authType,
              properties: conn.properties,
              hasSecret: conn.hasSecret,
            }}
          />
          <form action={deleteConnectionAction.bind(null, conn.id)} className="mt-10 border-t border-border pt-6">
            <Button variant="ghost" className="text-danger" type="submit">
              Delete connection
            </Button>
          </form>
        </>
      ) : (
        <Card className="p-5 text-sm text-fg-muted">Base URL: {String(conn.properties.baseUrl ?? "")}</Card>
      )}
    </>
  );
}
