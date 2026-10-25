import { Hammer } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/card";

/** Placeholder for sections built in a later phase (replica/architecture.md). */
export function ComingSoon({ title, phase, children }: { title: string; phase: number; children: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState icon={<Hammer />} title={`Arrives in phase ${phase}`}>
        {children}
      </EmptyState>
    </>
  );
}
