"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { JobCardModel } from "@/lib/progress/view";
import { cn } from "@/lib/utils";

export function JobActions({
  card,
  pending,
  onAction,
}: {
  card: JobCardModel;
  pending: boolean;
  onAction: (action: "pause" | "resume" | "cancel") => void;
}) {
  if (!card.canPause && !card.canResume && !card.canCancel && !card.pauseNote && !card.cancelNote) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {card.canPause ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction("pause")}>
          Пауза
        </Button>
      ) : null}
      {card.canResume ? (
        <Button size="sm" disabled={pending} onClick={() => onAction("resume")}>
          Продолжить
        </Button>
      ) : null}
      {card.canCancel ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction("cancel")}>
          Отменить
        </Button>
      ) : null}
      {card.pauseNote ? <p className="text-xs text-muted-foreground">{card.pauseNote}</p> : null}
      {card.cancelNote ? <p className="text-xs text-muted-foreground">{card.cancelNote}</p> : null}
    </div>
  );
}

export function JobCard({
  card,
  pending,
  onAction,
}: {
  card: JobCardModel;
  pending: boolean;
  onAction: (action: "pause" | "resume" | "cancel") => void;
}) {
  return (
    <article className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {card.kindLabel}
            {card.host ? ` · ${card.host}` : ""}
          </p>
          <Link href={card.href} className="block truncate text-base font-semibold hover:text-primary">
            {card.title}
          </Link>
          <p className="mt-1 text-xs text-muted-foreground">{card.statusLabel}</p>
        </div>
        <p className="text-lg font-semibold tabular-nums">{card.percentLabel}</p>
      </div>
      <ProgressMeter card={card} />
      <dl className="mt-3 grid grid-cols-1 gap-2 text-sm min-[420px]:grid-cols-2">
        <Field label="Данные" value={card.bytesLabel} />
        <Field label="Скорость" value={card.speedLabel} />
        <Field label="Осталось" value={card.etaLabel} />
        <Field label="Файл" value={card.currentFile ?? "—"} />
      </dl>
      {card.diskLabel || card.outputPath ? (
        <p className="mt-2 truncate font-mono text-xs text-muted-foreground" title={card.outputPath ?? card.diskLabel ?? ""}>
          {[card.diskLabel, card.outputPath].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {card.error ? <p className="mt-3 text-sm text-destructive">{card.error}</p> : null}
      <JobActions card={card} pending={pending} onAction={onAction} />
    </article>
  );
}

export function ProgressMeter({ card }: { card: JobCardModel }) {
  const width = Math.max(0, Math.min(100, card.percent));
  const tone = card.status === "error" ? "bg-destructive" : card.status === "completed" ? "bg-seed" : "bg-primary";
  return (
    <div
      className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
      aria-label={card.title}
    >
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${width}%` }} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate tabular-nums">{value}</dd>
    </div>
  );
}
