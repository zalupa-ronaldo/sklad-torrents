"use client";

import { toast } from "sonner";

import { PipelineBanner } from "@/app/scheduler/pipeline-banner";
import { AppShell } from "@/components/app-shell";
import { DownloadQueue, type QueueCommand } from "@/components/download-queue";
import { BoardMessage, useProgress } from "@/components/progress-screen";
import { api } from "@/lib/api-client";
import type { ProgressPayload } from "@/lib/progress/jobs";
import type { PipelineView } from "@/lib/scheduler/auto-queue";

export function SchedulerHome({ initial, pipeline }: { initial: ProgressPayload; pipeline: PipelineView }) {
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
    <AppShell current="scheduler" subtitle="Авторежим и одна загрузка на диск">
      <PipelineBanner initial={pipeline} />
      <BoardMessage error={error} hasData={Boolean(data)} onRetry={() => void refresh()} />
      <DownloadQueue queues={data?.queues ?? []} pending={pending} onCommand={(command) => void onCommand(command)} />
    </AppShell>
  );
}
