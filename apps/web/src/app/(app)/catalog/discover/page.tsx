import { assertCan, getSemanticGraph } from "@oicr/db";
import Link from "next/link";
import { Card, PageHeader } from "@/components/ui/card";
import { aiEnabled, aiHint, aiLabel } from "@/lib/ai";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { DiscoverForm } from "./discover-form";

export const metadata = { title: "Bind a system object" };

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ system?: string; object?: string }>;
}) {
  const viewer = await requireViewer();
  assertCan(viewer, "build");
  const { system, object } = await searchParams;
  const graph = await getSemanticGraph(db, viewer);
  return (
    <>
      <PageHeader
        title="Bind a system object"
        description="Tell the catalog what a table, resource or record type holds. Paste a sample and the AI proposes which business attribute each field is; you review what it is not sure about."
      />
      <p className="-mt-4 mb-6 text-sm text-fg-muted">
        <Link href="/catalog" className="text-accent hover:underline">
          Semantic catalog
        </Link>{" "}
        / Bind a system object
      </p>
      <Card className="p-5">
        <DiscoverForm
          initial={{ system: system ?? "", object: object ?? "" }}
          systems={graph.systems().map((s) => ({ id: s.id, label: s.label }))}
          entities={graph.entities().map((e) => ({ name: e.name, label: e.label }))}
          ai={aiEnabled() ? { label: aiLabel() ?? "AI" } : { hint: aiHint() }}
        />
      </Card>
    </>
  );
}
