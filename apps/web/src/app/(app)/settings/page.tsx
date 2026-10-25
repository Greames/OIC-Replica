import { memberships, users } from "@oicr/db";
import { asc, eq } from "drizzle-orm";
import { Badge, Card, PageHeader } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";

export const metadata = { title: "Settings" };

const roleHelp: Record<string, string> = {
  admin: "Everything, including members and billing",
  developer: "Build, activate and operate integrations",
  monitor: "Watch runs, resubmit failures",
  viewer: "Read only",
};

export default async function SettingsPage() {
  const viewer = await requireViewer();
  const members = await db
    .select({ id: memberships.id, role: memberships.role, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, viewer.orgId))
    .orderBy(asc(memberships.createdAt));

  return (
    <>
      <PageHeader title="Settings" description={viewer.orgName} />
      <h2 className="mb-3 font-medium">Members</h2>
      <Card className="divide-y divide-border">
        {members.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
            <div className="min-w-0">
              <div className="truncate font-medium">{m.name}</div>
              <div className="truncate text-sm text-fg-muted">{m.email}</div>
            </div>
            <Badge title={roleHelp[m.role]}>{m.role}</Badge>
          </div>
        ))}
      </Card>
      <p className="mt-3 text-sm text-fg-muted">
        Inviting members, API keys and notification channels arrive in later phases.
      </p>
    </>
  );
}
