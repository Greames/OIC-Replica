import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { OrgForm } from "./org-form";

export const metadata = { title: "Create your workspace" };

export default async function OnboardingPage() {
  const h = await headers();
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) redirect("/sign-in");
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <OrgForm defaultName={`${session.user.name.split(" ")[0]}'s team`} />
      </div>
    </main>
  );
}
