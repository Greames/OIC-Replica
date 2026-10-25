import { cn } from "@/lib/utils";

const tone: Record<string, string> = {
  active: "bg-success/15 text-success",
  succeeded: "bg-success/15 text-success",
  configured: "bg-accent/15 text-accent",
  running: "bg-accent/15 text-accent",
  queued: "bg-muted text-fg-muted",
  draft: "bg-muted text-fg-muted",
  inactive: "bg-muted text-fg-muted",
  skipped: "bg-muted text-fg-muted",
  failed: "bg-danger/15 text-danger",
  aborted: "bg-danger/15 text-danger",
};

const label: Record<string, string> = { configured: "ready" };

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
        tone[status] ?? "bg-muted text-fg-muted",
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label[status] ?? status}
    </span>
  );
}
