"use client";

import { Gamepad2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/tools", label: "Очередь" },
  { href: "/tools/index", label: "Индекс" },
  { href: "/tools/transcode", label: "Перекодировать" },
  { href: "/tools/move", label: "Перенос игры" },
  { href: "/tools/compress", label: "Сжать" },
  { href: "/tools/settings", label: "Настройки" },
];

export function ToolsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Gamepad2 className="size-4" />
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight">Медиа и игры</h1>
            <p className="truncate text-xs text-muted-foreground">HandBrake, перенос папок и NTFS на своих машинах</p>
          </div>
        </div>
        <Link href="/" className="text-sm text-primary hover:underline sm:ml-auto">
          Раздачи
        </Link>
      </header>
      <nav className="flex flex-wrap gap-2 border-b px-4 py-2">
        {LINKS.map((link) => {
          const active = link.href === "/tools" ? pathname === "/tools" : pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs",
                active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-6">{children}</main>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span>{label}</span>
      {children}
      {hint ? <span className="text-xs leading-5 text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export const pathInputClass = "font-mono text-xs";

export function selectClassName(): string {
  return "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
}

export function Meter({ value }: { value: number }) {
  const width = Math.max(0, Math.min(100, (Number.isFinite(value) ? value : 0) * 100));
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
    </div>
  );
}

export function Status({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="py-10">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="mt-2 max-w-lg text-sm text-muted-foreground">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
