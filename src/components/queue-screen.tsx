"use client";

import { toast } from "sonner";

import { AppShell } from "@/components/app-shell";
import { DownloadQueue, type QueueCommand } from "@/components/download-queue";
import { BoardMessage, useProgress } from "@/components/progress-screen";
import { api } from "@/lib/api-client";
import type { ProgressPayload } from "@/lib/progress/jobs";

export function QueueScreen({ initial }: { initial: ProgressPayload }) {
  const { data, error, pending, setPending, refresh } = useProgress(initial);

  async function onCommand(command: QueueCommand) {
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

  return (
    <AppShell current="scheduler" subtitle="Одна загрузка на физический диск">
      <BoardMessage error={error} hasData={Boolean(data)} onRetry={() => void refresh()} />
      <DownloadQueue queues={data?.queues ?? []} pending={pending} onCommand={(command) => void onCommand(command)} />
    </AppShell>
  );
}
