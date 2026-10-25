import { Workflow } from "lucide-react";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2 font-semibold">
          <Workflow className="size-6 text-accent" aria-hidden />
          OIC-Replica
        </div>
        {children}
      </div>
    </main>
  );
}
