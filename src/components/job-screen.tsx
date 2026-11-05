"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { JobActions, ProgressMeter } from "@/components/job-card";
import { BoardMessage, useProgress } from "@/components/progress-screen";
import { api } from "@/lib/api-client";
import type { ProgressPayload } from "@/lib/progress/jobs";
import { toJobCard } from "@/lib/progress/view";

export function JobScreen({ id, initial }: { id: string; initial: ProgressPayload }) {
  const { data, error, refresh } = useProgress(initial);
  const [pending, setPending] = useState(false);
  const decoded = decodeJobId(id);
  const snapshot = data?.jobs.find((job) => job.id === decoded || job.id === id) ?? null;
  const card = snapshot ? toJobCard(snapshot) : null;

  async function onAction(action: "pause" | "resume" | "cancel") {
    if (!card) return;
    if (action === "cancel" && !window.confirm("Остановить операцию? Файлы на диске не будут удалены.")) return;
    setPending(true);
    try {
      const result = await api<{ notice?: string }>(`/api/progress/${encodeURIComponent(card.id)}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (result.notice) toast.message(result.notice);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не получилось");
    } finally {
      setPending(false);
    }
  }

  return (
    <AppShell current="progress" subtitle="Одна операция">
      <BoardMessage error={error} hasData={Boolean(data)} onRetry={() => void refresh()} />
      <Link href="/progress" className="mb-4 text-sm text-primary hover:underline">
        Все операции
      </Link>
      {!card ? (
        <div className="rounded-xl border border-dashed px-4 py-10">
          <h2 className="text-lg font-medium">Операция не найдена</h2>
          <p className="mt-2 text-sm text-muted-foreground">Её нет среди текущих и недавних задач.</p>
        </div>
      ) : (
        <article className="rounded-xl border bg-card p-4 sm:p-6">
          <p className="text-xs text-muted-foreground">{card.kindLabel}</p>
          <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-xl font-semibold tracking-tight">{card.title}</h2>
            <p className="text-2xl font-semibold tabular-nums">{card.percentLabel}</p>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{card.statusLabel}</p>
          <ProgressMeter card={card} />
          {card.error ? <p className="mt-4 text-sm text-destructive">{card.error}</p> : null}
          <dl className="mt-5 grid grid-cols-1 gap-4 text-sm min-[420px]:grid-cols-2">
            <Detail label="Текущий файл" value={card.currentFile ?? "—"} />
            <Detail label="Обработано" value={card.bytesLabel} />
            <Detail label="Скорость" value={card.speedLabel} />
            <Detail label="Осталось" value={card.etaLabel} />
            <Detail label="Хост" value={card.host ?? "—"} />
            <Detail label="Диск" value={card.diskLabel ?? "—"} />
            <Detail label="Путь" value={card.outputPath ?? "—"} wide mono />
          </dl>
          <JobActions card={card} pending={pending} onAction={(action) => void onAction(action)} />
        </article>
      )}
    </AppShell>
  );
}

function Detail({ label, value, wide, mono }: { label: string; value: string; wide?: boolean; mono?: boolean }) {
  return (
    <div className={wide ? "min-[420px]:col-span-2" : undefined}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-1 font-mono text-xs break-all" : "mt-1 break-all tabular-nums"}>{value}</dd>
    </div>
  );
}

function decodeJobId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}
