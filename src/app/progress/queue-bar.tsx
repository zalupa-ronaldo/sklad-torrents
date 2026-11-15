"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { formatEta, formatPercent, formatSpeed } from "@/lib/format";
import type { LinkStatus } from "@/lib/progress/channel";
import type { LoadPolicy, ProcessPriority } from "@/lib/progress/control";
import type { QueueBoard } from "@/lib/progress/board";
import type { ProgressPayload } from "@/lib/progress/jobs";

const PRIORITY_LABEL: Record<ProcessPriority, string> = {
  idle: "простой",
  "below-normal": "ниже обычного",
  normal: "обычный",
};

export function QueueBar({ data, onChanged }: { data: ProgressPayload | null; onChanged: () => Promise<void> }) {
  const board = boardOf(data);
  const [link, setLink] = useState<LinkStatus | null>(null);
  const [draft, setDraft] = useState<LoadPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const load = draft ?? board?.load ?? null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api<LinkStatus>("/api/hosts/link");
        if (cancelled) return;
        setLink(next);
        await api("/api/progress/link", { method: "POST", body: JSON.stringify(next) });
      } catch {
        if (!cancelled) setLink(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!board || !load) return null;
  const summary = board.summary;
  const linkLine = link && link.state !== "up" ? linkDetail(link) : null;

  async function run(action: "pause" | "resume" | "cancel", scope: "all" | "mac-local" | "pc-agent") {
    if (action === "cancel" && !window.confirm("Остановить задачи? Файлы на диске не удаляются.")) return;
    setBusy(true);
    try {
      const result = await api<{ notice?: string }>("/api/progress/queue", {
        method: "POST",
        body: JSON.stringify({ action, scope }),
      });
      if (result.notice) toast.message(result.notice);
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не получилось");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/progress/load", { method: "POST", body: JSON.stringify(load) });
      toast.message("Лимиты сохранены. Они действуют и после перезапуска.");
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не получилось сохранить лимиты");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6 grid gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Общая очередь</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatPercent(summary.percent)} · {formatSpeed(summary.speed)} · {summary.eta >= 8_640_000 ? "осталось —" : `осталось ${formatEta(summary.eta)}`}
            {summary.currentFile ? ` · ${summary.currentFile}` : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Идёт {summary.running}, на паузе {summary.paused}, в очереди {summary.queued}. Приоритет процесса: {PRIORITY_LABEL[load.processPriority]}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {board.queuePaused ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => void run("resume", "all")}>
              Продолжить очередь
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run("pause", "all")}>
              Пауза очереди
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run("cancel", "all")}>
            Отменить очередь
          </Button>
        </div>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(summary.percent * 100)}
        aria-label="Общий прогресс очереди"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(summary.percent * 100)}%` }} />
      </div>
      {linkLine ? <p className="text-sm text-muted-foreground">{linkLine}</p> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {board.machines.map((machine) => (
          <article key={machine.host} className="rounded-lg border px-3 py-3">
            <h3 className="text-sm font-semibold">
              {machine.label} · {machine.encoder}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatPercent(machine.summary.percent)} · HandBrake {machine.handbrakeRunning}/{machine.handbrakeSlots} · параллельно {machine.running}/{machine.maxParallel}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">Следующий файл: {machine.nextFile ?? "—"}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {machine.paused ? (
                <Button type="button" size="xs" disabled={busy || board.queuePaused} onClick={() => void run("resume", machine.host)}>
                  Продолжить {machine.label}
                </Button>
              ) : (
                <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void run("pause", machine.host)}>
                  Пауза {machine.label}
                </Button>
              )}
              <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void run("cancel", machine.host)}>
                Отменить {machine.label}
              </Button>
            </div>
          </article>
        ))}
      </div>
      <form className="grid gap-3 border-t pt-3" onSubmit={(event) => void save(event)}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Приоритет
            <select
              className="h-8 rounded-lg border bg-background px-2 text-sm text-foreground"
              value={load.processPriority}
              onChange={(event) => setDraft({ ...load, processPriority: event.target.value as ProcessPriority })}
            >
              <option value="idle">простой</option>
              <option value="below-normal">ниже обычного</option>
              <option value="normal">обычный</option>
            </select>
          </label>
          <Limit label="Параллельно Mac" value={load.maxParallel["mac-local"]} min={1} max={8} onChange={(value) => setDraft({ ...load, maxParallel: { ...load.maxParallel, "mac-local": value } })} />
          <Limit label="Параллельно ПК" value={load.maxParallel["pc-agent"]} min={1} max={8} onChange={(value) => setDraft({ ...load, maxParallel: { ...load.maxParallel, "pc-agent": value } })} />
          <Limit label="HandBrake Mac" value={load.handbrakeSlots["mac-local"]} min={0} max={4} onChange={(value) => setDraft({ ...load, handbrakeSlots: { ...load.handbrakeSlots, "mac-local": value } })} />
          <Limit label="HandBrake ПК" value={load.handbrakeSlots["pc-agent"]} min={0} max={4} onChange={(value) => setDraft({ ...load, handbrakeSlots: { ...load.handbrakeSlots, "pc-agent": value } })} />
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={load.schedule.enabled}
              onChange={(event) => setDraft({ ...load, schedule: { ...load.schedule, enabled: event.target.checked } })}
            />
            Расписание
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            с
            <input
              type="time"
              value={minutesToTime(load.schedule.startMinute)}
              onChange={(event) => setDraft({ ...load, schedule: { ...load.schedule, startMinute: timeToMinutes(event.target.value) } })}
            />
            до
            <input
              type="time"
              value={minutesToTime(load.schedule.endMinute)}
              onChange={(event) => setDraft({ ...load, schedule: { ...load.schedule, endMinute: timeToMinutes(event.target.value) } })}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={load.yieldWhileActive}
            onChange={(event) => setDraft({ ...load, yieldWhileActive: event.target.checked })}
          />
          Не мешать, когда я играю или работаю
        </label>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={load.userActive["mac-local"]}
              onChange={(event) => setDraft({ ...load, userActive: { ...load.userActive, "mac-local": event.target.checked } })}
            />
            Mac занят
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={load.userActive["pc-agent"]}
              onChange={(event) => setDraft({ ...load, userActive: { ...load.userActive, "pc-agent": event.target.checked } })}
            />
            ПК занят
          </label>
        </div>
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Сохранить лимиты
          </Button>
        </div>
      </form>
    </section>
  );
}

function Limit({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <input
        className="h-8 w-20 rounded-lg border bg-background px-2 text-sm text-foreground"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function boardOf(data: ProgressPayload | null): QueueBoard | null {
  if (!data || !("summary" in data) || !("machines" in data) || !("load" in data)) return null;
  return data as ProgressPayload & QueueBoard;
}

function linkDetail(link: LinkStatus): string {
  const peer = link.peers["pc-agent"].detail || link.peers["mac-local"].detail;
  if (peer) return peer;
  if (link.state === "recovering") return "Адрес WSL сменился. Канал восстанавливается.";
  return "Канал socat не запущен.";
}

function minutesToTime(minutes: number): string {
  const clamped = Math.min(1439, Math.max(0, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number {
  const [hours, mins] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return 0;
  return Math.min(1440, Math.max(0, hours * 60 + mins));
}
