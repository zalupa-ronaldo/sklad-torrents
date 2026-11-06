"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", id: "torrents", label: "Склад" },
  { href: "/optical", id: "optical", label: "DVD" },
  { href: "/drives", id: "drives", label: "Полка" },
  { href: "/localsend", id: "localsend", label: "LocalSend" },
  { href: "/progress", id: "progress", label: "Задачи" },
  { href: "/scheduler", id: "scheduler", label: "Очередь" },
  { href: "/tools", id: "tools", label: "Инструменты" },
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
