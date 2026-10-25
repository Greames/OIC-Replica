import "server-only";
import { type Actor, memberships, orgs, ROLES, type Role } from "@oicr/db";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "./auth";
import { db } from "./db";

export interface Viewer extends Actor {
  name: string;
  email: string;
  orgName: string;
}

/** The signed-in user and their active org. Redirects to sign in / onboarding. */
export const requireViewer = cache(async (): Promise<Viewer> => {
  const h = await headers();
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) redirect("/sign-in");

  const userId = session.user.id;
  let orgId = session.session.activeOrganizationId as string | null | undefined;

  if (!orgId) {
    const [first] = await db
      .select({ orgId: memberships.organizationId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.createdAt))
      .limit(1);
    if (!first) redirect("/onboarding");
    await getAuth().api.setActiveOrganization({ body: { organizationId: first.orgId }, headers: h });
    orgId = first.orgId;
  }

  const [row] = await db
    .select({ role: memberships.role, orgName: orgs.name })
    .from(memberships)
    .innerJoin(orgs, eq(orgs.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, orgId)));
  if (!row) redirect("/onboarding");

  const role: Role = (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer";
  return { userId, orgId, role, orgName: row.orgName, name: session.user.name, email: session.user.email };
});
