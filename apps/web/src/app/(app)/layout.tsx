import { Workflow } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { SignOutButton } from "@/components/sign-out";
import { requireViewer } from "@/lib/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-border bg-panel p-4 md:sticky md:top-0 md:h-dvh md:w-60 md:gap-6 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-3 md:flex-col md:items-stretch md:gap-6">
          <Link href="/" className="flex items-center gap-2 px-1 font-semibold">
            <Workflow className="size-5 text-accent" aria-hidden />
            OIC-Replica
          </Link>
          <div className="flex min-w-0 items-center gap-2 px-1 text-xs md:block">
            <div className="hidden text-fg-muted md:block">Workspace</div>
            <div className="truncate font-medium">{viewer.orgName}</div>
            <div className="md:hidden">
              <SignOutButton />
            </div>
          </div>
        </div>
        <Nav />
        <div className="mt-auto hidden items-center justify-between gap-2 border-t border-border px-1 pt-4 md:flex">
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{viewer.name}</div>
            <div className="truncate text-fg-muted">
              {viewer.email} · {viewer.role}
            </div>
          </div>
          <SignOutButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-8 md:px-10">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
