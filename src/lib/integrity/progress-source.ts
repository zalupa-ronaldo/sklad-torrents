import { listIntegrityJobs } from "@/lib/integrity/engine";
import type { IntegrityJob, IntegrityKind, IntegrityState } from "@/lib/integrity/types";
import { registerJobSource } from "@/lib/progress/sources";
import type { JobKind, JobSnapshot, JobStatus } from "@/lib/progress/types";

registerJobSource({
  id: "sha256",
  async list() {
    const jobs = await listIntegrityJobs();
    return jobs.map(toSnapshot);
  },
});

function toSnapshot(job: IntegrityJob): JobSnapshot {
  const status = mapState(job.state);
  const current = [job.currentFile, job.filesTotal > 0 ? `${job.filesDone}/${job.filesTotal}` : ""]
    .filter(Boolean)
    .join(" · ");
  return {
    id: job.id,
    kind: mapKind(job.kind),
    title: job.title,
    status,
    progress: Math.min(1, Math.max(0, job.percent / 100)),
    processedBytes: job.bytesHashed,
    totalBytes: job.bytesTotal,
    speed: job.speed,
    eta: job.etaSeconds ?? 8_640_000,
    currentFile: current || null,
    host: null,
    diskLabel: job.kind === "optical" ? "проверка чтения, не стирание" : null,
    outputPath: job.destinationLabel || job.sourceLabel || null,
    error: job.mismatchPaths.length > 0 ? `Отличается: ${job.mismatchPaths.join(", ")}` : job.error,
    capabilities: {
      pause: false,
      resume: false,
      cancel: status === "running" || status === "queued",
    },
    pauseUnsupportedReason: "Пауза подсчёта — это отмена. Уже посчитанные хэши остаются, файлы не удаляются.",
    updatedAt: Date.parse(job.updatedAt) || Date.now(),
  };
}

function mapKind(kind: IntegrityKind): JobKind {
  if (kind === "torrent") return "torrent";
  if (kind === "compact") return "compact";
  if (kind === "handbrake") return "transcode";
  if (kind === "optical") return "optical";
  if (kind === "localsend") return "localsend";
  return "copy";
}

function mapState(state: IntegrityState): JobStatus {
  if (state === "done") return "completed";
  if (state === "cancelled") return "cancelled";
  if (state === "error") return "error";
  if (state === "paused") return "paused";
  if (state === "running") return "running";
  return "queued";
}
