import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-lg border border-border bg-panel px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
