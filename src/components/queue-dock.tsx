"use client";

import { JobActions } from "@/components/job-card";
import { type LoadPolicy, queueTotals } from "@/components/panel-model";
import { Button } from "@/components/ui/button";
import { formatBytes, formatEta, formatPercent, formatSpeed } from "@/lib/format";
import { toJobCard, type JobCardModel } from "@/lib/progress/view";
import type { JobSnapshot } from "@/lib/progress/types";
import { cn } from "@/lib/utils";

export function QueueDock({
  jobs,
  pending,
  policy,
  onPolicy,
  onAction,
  onQueueAction,
}: {
  jobs: JobSnapshot[];
  pending: boolean;
  policy: LoadPolicy;
  onPolicy: (next: LoadPolicy) => void;
  onAction: (id: string, action: "pause" | "resume" | "cancel") => void;
  onQueueAction: (action: "pause" | "resume" | "cancel") => void;
}) {
  const cards = jobs.map((job) => toJobCard(job)).filter((card) => card.status === "running" || card.status === "paused" || card.status === "queued" || card.status === "error");
  const totals = queueTotals(jobs);
  const width = Math.max(0, Math.min(100, totals.progress * 100));

  return (
    <section data-testid="queue-dock" className="flex min-h-0 min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
        <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Очередь</h2>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {formatPercent(totals.progress)} · {formatSpeed(totals.speed)} · {totals.eta >= 8_640_000 ? "осталось —" : `осталось ${formatEta(totals.eta)}`} · {totals.runningCount} из {totals.liveCount}
        </span>
      </div>
      <div
        className="mx-2 h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
        aria-label="Общий прогресс очереди"
        data-testid="queue-progress"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
      </div>
      <p className="px-2 pt-1 text-[10px] text-muted-foreground">
        {formatBytes(totals.processedBytes)} из {formatBytes(totals.totalBytes)}. Пауза остаётся в очереди после перезапуска. Продолжить идёт с места остановки.
      </p>
      <div className="flex flex-wrap gap-1 px-2 py-1">
        <Button type="button" size="xs" variant="outline" disabled={pending} onClick={() => onQueueAction("pause")}>
          Пауза очереди
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={pending} onClick={() => onQueueAction("resume")}>
          Продолжить очередь
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={pending} onClick={() => onQueueAction("cancel")}>
          Отмена очереди
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-2 pb-1 text-[11px]">
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={policy.quiet}
            onChange={(event) => onPolicy({ ...policy, quiet: event.target.checked })}
          />
          Не мешать, когда я играю или работаю
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={policy.limitParallel}
            onChange={(event) => onPolicy({ ...policy, limitParallel: event.target.checked })}
          />
          Одновременно
          <input
            aria-label="Число параллельных задач"
            type="number"
            min={1}
            max={8}
            value={policy.parallel}
            className="h-6 w-12 rounded border border-input bg-transparent px-1"
            onChange={(event) => onPolicy({ ...policy, limitParallel: true, parallel: Number(event.target.value) })}
          />
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={policy.scheduleEnabled}
            onChange={(event) => onPolicy({ ...policy, scheduleEnabled: event.target.checked })}
          />
          Только с
          <input
            aria-label="Начало расписания"
            type="time"
            value={toTimeValue(policy.scheduleFrom)}
            className="h-6 rounded border border-input bg-transparent px-1"
            onChange={(event) => onPolicy({ ...policy, scheduleEnabled: true, scheduleFrom: event.target.value })}
          />
          до
          <input
            aria-label="Конец расписания"
            type="time"
            value={toTimeValue(policy.scheduleTo)}
            className="h-6 rounded border border-input bg-transparent px-1"
            onChange={(event) => onPolicy({ ...policy, scheduleEnabled: true, scheduleTo: event.target.value })}
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2">
        {cards.length === 0 ? <p className="py-2 text-[11px] text-muted-foreground">Нет активных задач.</p> : cards.map((card) => <TaskRow key={card.id} card={card} pending={pending} onAction={onAction} />)}
      </div>
    </section>
  );
}

function TaskRow({
  card,
  pending,
  onAction,
}: {
  card: JobCardModel;
  pending: boolean;
  onAction: (id: string, action: "pause" | "resume" | "cancel") => void;
}) {
  const width = Math.max(0, Math.min(100, card.percent));
  return (
    <article className="rounded-md border px-2 py-1.5 text-[11px]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">
            {card.kindLabel} · {card.title}
          </div>
          <div className="text-muted-foreground">
            {card.statusLabel} · {card.percentLabel} · {card.speedLabel} · {card.etaLabel}
          </div>
          <div className="truncate text-muted-foreground" title={card.currentFile ?? ""}>
            Файл: {card.currentFile ?? "—"}
          </div>
        </div>
      </div>
      <div className={cn("mt-1 h-1 overflow-hidden rounded-full bg-muted")} role="progressbar" aria-valuenow={Math.round(width)} aria-label={card.title}>
        <div className="h-full bg-primary" style={{ width: `${width}%` }} />
      </div>
      <JobActions card={card} pending={pending} onAction={(action) => onAction(card.id, action)} />
    </article>
  );
}

function toTimeValue(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return "00:00";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}
