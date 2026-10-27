import { getLookup, lookupUsage } from "@oicr/db";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";
import { LookupEditor } from "../lookup-editor";

export const metadata = { title: "Lookup" };

export default async function LookupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const lookup = await getLookup(db, viewer, id).catch(() => null);
  if (!lookup) notFound();
  const usage = await lookupUsage(db, viewer.orgId, lookup.name);
  return (
    <>
      <PageHeader title={lookup.name} description={lookup.description ?? "Lookup"} />
      <LookupEditor
        id={lookup.id}
        initial={{
          name: lookup.name,
          description: lookup.description ?? "",
          domains: lookup.domains,
          rows: lookup.rows,
        }}
        usage={usage}
      />
    </>
  );
}
