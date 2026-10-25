import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/card";
import { requireViewer } from "@/lib/session";
import { SettingsNav } from "./settings-nav";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  return (
    <>
      <PageHeader title="Settings" description={viewer.orgName} />
      <SettingsNav />
      {children}
    </>
  );
}
