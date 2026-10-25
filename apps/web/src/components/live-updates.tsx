"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface LiveEvent {
  id: number;
  type: string;
  severity: "info" | "warning" | "error";
  summary: string;
  path: string | null;
  data: Record<string, unknown>;
}

const TOAST_TYPES = new Set([
  "instance.failed",
  "instance.succeeded",
  "schedule.skipped",
  "ai.question",
  "connection.test_failed",
  "integration.deactivated",
]);
const LIVE_PAGES = ["/", "/observability", "/activity", "/integrations", "/connections"];

/**
 * Keeps the app live: listens to the workspace's events (SSE), refreshes the
 * page when an event concerns it, and shows toasts for runs and anything
 * that needs attention. Other components can listen for "oicr:event".
 */
export function LiveUpdates() {
  const router = useRouter();
  const pathname = usePathname();
  const path = useRef(pathname);
  path.current = pathname;
  const [toasts, setToasts] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const source = new EventSource("/api/events/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false); // EventSource reconnects by itself
    source.addEventListener("update", (msg) => {
      const e = JSON.parse((msg as MessageEvent<string>).data) as LiveEvent;
      window.dispatchEvent(new CustomEvent("oicr:event", { detail: e }));
      const here = path.current;
      const integrationId = typeof e.data.integrationId === "string" ? e.data.integrationId : null;
      const concernsPage =
        LIVE_PAGES.includes(here) ||
        (e.path !== null && here === e.path) ||
        (integrationId !== null && here.includes(integrationId));
      if (concernsPage && !refreshTimer) {
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          router.refresh();
        }, 400);
      }
      if (TOAST_TYPES.has(e.type) && e.path !== here) {
        setToasts((t) => [...t.slice(-3), e]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== e.id)), e.severity === "error" ? 12_000 : 6_000);
      }
    });
    return () => {
      source.close();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [router]);

  return (
    <>
      <span className="sr-only" data-live-connected={connected ? "yes" : "no"}>
        {connected ? "Live updates on" : "Live updates reconnecting"}
      </span>
      <section
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed right-0 bottom-0 z-50 flex w-full max-w-sm flex-col gap-2 p-4"
        style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom, 0px))" }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-xl border bg-panel p-3 text-sm shadow-lg",
              t.severity === "error"
                ? "border-danger/50"
                : t.severity === "warning"
                  ? "border-amber-500/50"
                  : "border-border",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-1.5 size-2 shrink-0 rounded-full",
                t.severity === "error" ? "bg-danger" : t.severity === "warning" ? "bg-amber-500" : "bg-success",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="break-words">{t.summary}</p>
              {t.path && (
                <Link
                  href={t.path}
                  className="text-xs text-accent hover:underline"
                  onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
                >
                  Open
                </Link>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
              className="rounded p-0.5 text-fg-muted hover:bg-muted"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
