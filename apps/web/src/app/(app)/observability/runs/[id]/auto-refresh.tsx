"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes the page while a run is still going. SSE replaces this in phase 4. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 1500);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
