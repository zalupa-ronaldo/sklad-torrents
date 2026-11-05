import { getDisk, updateDiskFiles } from "@/lib/kernel/catalog";
import { ensureDemoState } from "@/lib/kernel/bootstrap";
import { applyIndexResult, planIndex } from "@/lib/kernel/index-engine";
import { claimNext, listJobs, pauseJob, reportProgress, type ProgressInput } from "@/lib/kernel/jobs";
import { markRemovalConfirmed, upsertLibrary } from "@/lib/kernel/media";
import { applyScheduler } from "@/lib/kernel/scheduler-run";
import type { JobRecord } from "@/lib/kernel/types";

const HOSTS = ["demo-mac", "demo-pc"] as const;

export function startDemoWorkers(): void {
  const flag = globalThis as typeof globalThis & { __skladDemoWorker?: boolean };
  if (flag.__skladDemoWorker) return;
  flag.__skladDemoWorker = true;
  const timer = setInterval(() => {
    void tick().catch((error) => {
      console.error("Демо-исполнитель Склада:", error instanceof Error ? error.message : error);
    });
  }, 1200);
  timer.unref?.();
}

async function tick(): Promise<void> {
  await ensureDemoState();
  for (const hostId of HOSTS) {
    const agentId = `builtin-${hostId}`;
    const jobs = await listJobs();
    const running = jobs.find((job) => job.hostId === hostId && job.state === "running" && job.claimedBy === agentId);
    if (running) await advance(running);
    else await claimNext(agentId, hostId);
  }
  await applyScheduler();
}

async function advance(job: JobRecord): Promise<void> {
  if (!job.claimToken) return;
  if (job.kind === "index") {
    const diskId = String(job.payload.diskId || "");
    if (diskId) {
      const disk = await getDisk(diskId).catch(() => null);
      if (disk?.heavyActivity) {
        await pauseJob(job.id);
        return;
      }
    }
  }
  const total = job.progress.totalBytes || 1;
  const step = Math.max(1, Math.ceil(total / 36));
  const processed = Math.min(total, job.progress.processedBytes + step);
  const speedBps = Math.round(step / 1.2);
  const etaSeconds = speedBps > 0 ? Math.round((total - processed) / speedBps) : null;
  const done = processed >= total;
  let state: ProgressInput["state"] = done ? "done" : "running";
  let message = done
    ? "Демо-исполнитель закончил. Реальные диски и HandBrake не вызывались."
    : `Демо: ${job.progress.currentFile}`;
  let payload: Record<string, unknown> | undefined;

  if (done && job.kind === "index") {
    const finished = await finishIndex(job);
    if (finished.paused) return;
    if (!finished.committed) {
      state = "error";
      message = finished.message;
    } else {
      message = finished.message;
      payload = { readOnly: true };
    }
  } else if (done && (job.kind === "move" || job.kind === "copy")) {
    await upsertLibrary({
      name: String(job.payload.libraryName || job.title),
      source: job.source,
      destination: job.destination,
      hostId: job.hostId,
      diskId: null,
      verified: true,
      sourceDeleted: false,
      removalConfirmed: false,
      jobId: job.id,
    });
    message = "Копия отмечена проверенной. Исходник на месте: удаление только отдельным подтверждением.";
    payload = { verified: true, sourceDeleted: false };
  } else if (done && job.kind === "compact") {
    const ratio = job.payload.algorithm === "LZX" ? 0.45 : 0.3;
    payload = { estimate: true, estimatedSavingsBytes: Math.round(total * ratio), sourceDeleted: false };
    message = "Демо-оценка экономии. compact.exe не запускался, файлы не изменялись.";
  } else if (done && job.kind === "transcode") {
    message = "Демо завершило очередь HandBrake. HandBrakeCLI не запускался, исходник не удалён.";
    payload = { mock: true, sourceDeleted: false };
  } else if (done && job.kind === "delete-source") {
    const entryId = String(job.payload.entryId || "");
    if (entryId) await markRemovalConfirmed(entryId);
    message = "Подтверждение записано. Демо-исполнитель не удалял файлы с диска.";
    payload = { sourceDeleted: false, removalConfirmed: true };
  }

  await reportProgress({
    id: job.id,
    claimToken: job.claimToken,
    processedBytes: processed,
    totalBytes: total,
    currentFile: job.progress.currentFile,
    speedBps,
    etaSeconds,
    message,
    state,
    payload,
  });
}

async function finishIndex(job: JobRecord): Promise<{ committed: boolean; paused: boolean; message: string }> {
  const diskId = String(job.payload.diskId || "");
  const disk = await getDisk(diskId).catch(() => null);
  if (!disk) return { committed: false, paused: false, message: "Диск для индексации не найден. Список файлов не менялся." };
  const outcome = planIndex({
    filesystem: disk.filesystem,
    mountPoint: disk.mounts[0]?.mountPoint || disk.lastMount?.mountPoint || disk.label,
    elevated: disk.elevated,
    previous: disk.indexedAt ? { files: disk.files, complete: disk.indexStatus === "complete" } : null,
    heavyActivity: disk.heavyActivity,
    walk: () => disk.files,
    readMft: () => disk.files,
    readUsn: (previous) => previous,
  });
  if (outcome.paused) {
    await pauseJob(job.id);
    return { committed: false, paused: true, message: outcome.message };
  }
  const files = applyIndexResult(disk.files, outcome);
  if (outcome.committed && outcome.method) {
    await updateDiskFiles(disk.id, files, "complete", outcome.method, null);
    return { committed: true, paused: false, message: outcome.message };
  }
  await updateDiskFiles(disk.id, disk.files, "error", disk.indexMethod, outcome.error);
  return { committed: false, paused: false, message: outcome.message };
}
