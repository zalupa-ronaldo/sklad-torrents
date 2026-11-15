"use client";

import { useEffect, useState } from "react";

import { api } from "@/lib/api-client";
import type { PipelineView } from "@/lib/scheduler/auto-queue";

const STATUS_LABEL: Record<PipelineView["runs"][number]["status"], string> = {
  queued: "В очереди",
  running: "Идёт",
  deferred: "Ждёт диск",
  done: "Готово",
  skipped: "Пропущен",
  error: "Ошибка",
};

export function PipelineBanner({ initial }: { initial: PipelineView }) {
  const [view, setView] = useState(initial);

  useEffect(() => {
    let stop = false;
    async function pull() {
      try {
        const next = await api<PipelineView>("/api/scheduler/auto");
        if (!stop) setView(next);
      } catch {
        // Keep the last snapshot. The panel stays usable.
      }
    }
    const timer = setInterval(() => void pull(), 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="mb-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Авторежим</h2>
        <p className="text-xs text-muted-foreground">
          После диска или торрента: индекс, тип, раскладка, копия, сжатие, проверка. Оригиналы не удаляются.
        </p>
      </div>
      {view.runs.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Пока нет новых дисков и завершённых раздач.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {view.runs.slice(0, 8).map((run) => (
            <li key={run.id} className="grid gap-1 rounded-lg bg-muted/40 px-3 py-2 text-sm sm:grid-cols-[9rem_1fr_auto]">
              <span className="text-muted-foreground">{run.stageLabel}</span>
              <span className="truncate">
                {run.title}
                {run.kindLabel ? ` · ${run.kindLabel}` : ""}
                {run.folder ? ` · ${run.folder}` : ""}
              </span>
              <span className="text-muted-foreground">{STATUS_LABEL[run.status]} · {Math.round(run.progress * 100)}%</span>
              {run.note ? <span className="text-xs text-muted-foreground sm:col-span-3">{run.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
