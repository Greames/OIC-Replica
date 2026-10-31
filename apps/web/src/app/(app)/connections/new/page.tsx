import { adapters } from "@oicr/adapters";
import { listProjects } from "@oicr/db";
import Link from "next/link";
import { PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ConnectionForm } from "../connection-form";

export const metadata = { title: "New connection" };

const COMING = ["Oracle Fusion", "NetSuite", "SAP S/4HANA", "SOAP", "SFTP", "Email"];

export default async function NewConnectionPage({ searchParams }: { searchParams: Promise<{ adapter?: string }> }) {
  const viewer = await requireViewer();
  const { adapter: chosen } = await searchParams;
  const projects = await listProjects(db, viewer);
  const adapter = adapters[chosen ?? ""] ?? adapters.rest!;
  return (
    <>
      <PageHeader title="New connection" description={`${adapter.name}: ${adapter.description}`} />
      <nav aria-label="Adapter" className="mb-4 flex flex-wrap gap-2">
        {Object.values(adapters).map((a) => (
          <Link
            key={a.id}
            href={`/connections/new?adapter=${a.id}`}
            aria-current={a.id === adapter.id ? "page" : undefined}
            className={cn(
              "rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted",
              a.id === adapter.id && "border-accent bg-accent/5 font-medium",
            )}
          >
            {a.name}
          </Link>
        ))}
      </nav>
      <p className="mb-6 text-sm text-fg-muted">More adapters are on the way: {COMING.join(", ")}.</p>
      <ConnectionForm
        key={adapter.id}
        adapter={{
          id: adapter.id,
          name: adapter.name,
          fields: adapter.fields,
          authTypes: adapter.authTypes,
          roles: adapter.roles,
        }}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      />
    </>
  );
}
