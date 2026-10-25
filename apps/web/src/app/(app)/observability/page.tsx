import { INSTANCE_STATUSES, type InstanceStatus, listInstances, listIntegrations } from "@oicr/db";
import Link from "next/link";
import { RunsTable } from "@/components/runs-table";
import { Button, buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { db } from "@/lib/db";
import { UUID } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

export const metadata = { title: "Runs" };

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ integration?: string; status?: string; q?: string; before?: string }>;
}) {
  const sp = await searchParams;
  const viewer = await requireViewer();
  const status = (INSTANCE_STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as InstanceStatus)
    : undefined;
  const integrationId = sp.integration && UUID.test(sp.integration) ? sp.integration : undefined;
  const [runs, integrations] = await Promise.all([
    listInstances(db, viewer, { integrationId, status, businessId: sp.q?.trim() || undefined, before: sp.before }),
    listIntegrations(db, viewer),
  ]);
  const nextHref = runs.next
    ? `/observability?${new URLSearchParams({ ...(integrationId ? { integration: integrationId } : {}), ...(status ? { status } : {}), ...(sp.q ? { q: sp.q } : {}), before: runs.next })}`
    : null;

  return (
    <>
      <PageHeader title="Runs" description="Every run of every integration, with its steps and payloads." />
      <search className="mb-4">
        <form className="grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto]">
          <Select name="integration" defaultValue={integrationId ?? ""} aria-label="Integration">
            <option value="">All integrations</option>
            {integrations.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
          <Select name="status" defaultValue={status ?? ""} aria-label="Status" className="sm:w-36">
            <option value="">Any status</option>
            {INSTANCE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Input name="q" defaultValue={sp.q} placeholder="Business ID, e.g. order 10045" aria-label="Business ID" />
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </form>
      </search>
      <RunsTable runs={runs.items} />
      {nextHref && (
        <div className="mt-4 flex justify-center">
          <Link href={nextHref} className={buttonVariants({ variant: "secondary" })}>
            Older runs
          </Link>
        </div>
      )}
    </>
  );
}
