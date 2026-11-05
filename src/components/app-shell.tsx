"use client";

import { HardDrive } from "lucide-react";
import Link from "next/link";

import { AppNav } from "@/components/app-nav";

export function AppShell({
  current,
  subtitle,
  children,
}: {
  current: "torrents" | "drives" | "policies" | "optical" | "localsend" | "progress" | "scheduler" | "tools";
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <HardDrive className="size-4" />
          </span>
          <div className="min-w-0">
            <Link href="/" className="text-base font-semibold tracking-tight">
              Склад
            </Link>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <AppNav current={current} />
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-4">{children}</main>
    </div>
  );
}
