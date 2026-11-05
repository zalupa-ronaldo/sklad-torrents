"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { FileEnqueue } from "@/components/file-enqueue";
import { DownloadQueue, type QueueCommand } from "@/components/download-queue";
import { JobCard } from "@/components/job-card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { fileJobSnapshot } from "@/lib/jobs/snapshot";
import type { JobEvent } from "@/lib/jobs/model";
import type { ProgressPayload } from "@/lib/progress/jobs";
import { toJobCard } from "@/lib/progress/view";

export function useProgress(initial: ProgressPayload | null) {
  const [data, setData] = useState<ProgressPayload | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api<ProgressPayload>("/api/progress");
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось обновить прогресс");
    }
  }, []);

  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const kick = window.setTimeout(run, 2_000);
    const timer = window.setInterval(run, 2_000);
    document.addEventListener("visibilitychange", run);
    const source = new EventSource("/api/jobs/events");
    const onEvent = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as JobEvent;
        if (event.type !== "upsert" && event.type !== "progress") return;
        const snapshot = fileJobSnapshot(event.job);
        setData((current) => {
          if (!current) return current;
          const index = current.jobs.findIndex((job) => job.id === snapshot.id);
          const jobs = current.jobs.slice();
          if (index === -1) jobs.unshift(snapshot);
          else jobs[index] = snapshot;
          return { ...current, jobs };
        });
      } catch {
        // Ignore a malformed frame; the poll still refreshes the page.
      }
    };
    source.addEventListener("upsert", onEvent);
    source.addEventListener("progress", onEvent);
    return () => {
      window.clearTimeout(kick);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
      source.close();
    };
  }, [refresh]);

  return { data, error, pending, setPending, refresh };
}

export function ProgressScreen({ initial }: { initial: ProgressPayload }) {
  const { data, error, pending, setPending, refresh } = useProgress(initial);
  const jobs = (data?.jobs ?? []).map((job) => toJobCard(job));
  const [jobPage, setJobPage] = useState(0);
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(jobs.length / pageSize));
  const page = Math.min(jobPage, pages - 1);
  const visible = jobs.slice(page * pageSize, page * pageSize + pageSize);

  async function onAction(id: string, action: "pause" | "resume" | "cancel") {
    if (action === "cancel" && !window.confirm("Остановить операцию? Файлы на диске не будут удалены.")) return;
    setPending(true);
    try {
      const result = await api<{ notice?: string }>(`/api/progress/${encodeURIComponent(id)}`, {
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
    <AppShell current="progress" subtitle="Долгие операции и очередь загрузок">
      <BoardMessage error={error} hasData={Boolean(data)} onRetry={() => void refresh()} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="order-2 grid gap-3 lg:order-1">
          <FileEnqueue />
          <h2 className="text-base font-semibold">Операции</h2>
          {jobs.length === 0 ? (
            <div className="rounded-xl border border-dashed px-4 py-10">
              <p className="text-lg font-medium">Сейчас ничего не выполняется</p>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Загрузки, индексация, копирование на SSD, сжатие CompactGUI и перекодирование HandBrake появятся здесь.
              </p>
            </div>
          ) : (
            visible.map((card) => (
              <JobCard key={card.id} card={card} pending={pending} onAction={(action) => void onAction(card.id, action)} />
            ))
          )}
          {jobs.length > pageSize ? (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {page * pageSize + 1}–{page * pageSize + visible.length} из {jobs.length}
              </span>
              <span className="flex gap-2">
                <Button type="button" size="xs" variant="outline" disabled={page <= 0} onClick={() => setJobPage(page - 1)}>
                  Назад
                </Button>
                <Button type="button" size="xs" variant="outline" disabled={page + 1 >= pages} onClick={() => setJobPage(page + 1)}>
                  Дальше
                </Button>
              </span>
            </div>
          ) : null}
        </section>
        <aside className="order-1 lg:sticky lg:top-4 lg:order-2">
          <DownloadQueue queues={data?.queues ?? []} pending={pending} onCommand={(command) => void runQueue(command)} />
        </aside>
      </div>
    </AppShell>
  );

  async function runQueue(command: QueueCommand) {
    setPending(true);
    try {
      const result = await api<{ notice?: string }>("/api/scheduler", {
        method: "POST",
        body: JSON.stringify(command),
      });
      if (result.notice) toast.message(result.notice);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не получилось изменить очередь");
    } finally {
      setPending(false);
    }
  }
}

export function BoardMessage({
  error,
  hasData,
  onRetry,
}: {
  error: string | null;
  hasData: boolean;
  onRetry: () => void;
}) {
  if (!error) return null;
  if (!hasData) {
    return (
      <div className="mb-4 rounded-xl border px-4 py-6">
        <h2 className="text-lg font-medium">Прогресс не загрузился</h2>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <Button className="mt-4" onClick={onRetry}>
          Повторить
        </Button>
      </div>
    );
  }
  return <p className="mb-4 text-sm text-warn">Данные могли устареть: {error}</p>;
}
