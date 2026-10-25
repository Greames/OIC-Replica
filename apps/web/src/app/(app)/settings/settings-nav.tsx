"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/settings", label: "Members" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/api-keys", label: "API keys" },
  { href: "/settings/hermes", label: "Hermes Agent" },
];

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={path === t.href ? "page" : undefined}
          className={cn(
            "shrink-0 border-b-2 px-3 py-2 text-sm",
            path === t.href ? "border-accent font-medium" : "border-transparent text-fg-muted hover:text-fg",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
