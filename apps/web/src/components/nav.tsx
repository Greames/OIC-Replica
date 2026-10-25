"use client";

import { Activity, BellRing, Cable, FolderKanban, Home, Settings, Table2, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Home", icon: Home },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/integrations", label: "Integrations", icon: Workflow },
  { href: "/connections", label: "Connections", icon: Cable },
  { href: "/lookups", label: "Lookups", icon: Table2 },
  { href: "/observability", label: "Observability", icon: Activity },
  { href: "/activity", label: "Activity", icon: BellRing },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="-mx-1 flex gap-0.5 overflow-x-auto px-1 md:mx-0 md:flex-col md:overflow-visible md:px-0"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-fg-muted hover:bg-muted hover:text-fg",
              active && "bg-muted font-medium text-fg",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
