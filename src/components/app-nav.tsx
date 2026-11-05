"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", id: "torrents", label: "Раздачи" },
  { href: "/optical", id: "optical", label: "Диски DVD" },
  { href: "/drives", id: "drives", label: "Полка дисков" },
  { href: "/localsend", id: "localsend", label: "LocalSend" },
  { href: "/policies", id: "policies", label: "Правила" },
  { href: "/progress", id: "progress", label: "Прогресс" },
  { href: "/scheduler", id: "scheduler", label: "Очередь" },
  { href: "/tools", id: "tools", label: "Медиа и игры" },
] as const;

export function AppNav({ current }: { current: (typeof LINKS)[number]["id"] }) {
  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="Разделы">
      {LINKS.map((link) => (
        <Link
          key={link.id}
          href={link.href}
          aria-current={current === link.id ? "page" : undefined}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs",
            current === link.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
