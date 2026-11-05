import type { PublicJob } from "@/lib/jobs/model";
import { HOST_LABEL, KIND_LABEL } from "@/lib/jobs/labels";
import type { JobKind, JobSnapshot, JobStatus } from "@/lib/progress/types";

export function fileJobSnapshot(job: PublicJob): JobSnapshot {
  const status: JobStatus = job.cancelled
    ? "cancelled"
    : job.state === "done"
      ? "completed"
      : job.state === "error"
        ? "error"
        : job.state;
  const kind: JobKind = job.kind === "move" ? "copy" : job.kind;
  const leaf = job.payload.source.split(/[/\\]/).pop() || job.payload.diskId || KIND_LABEL[job.kind];
  return {
    id: job.id,
    kind,
    title: job.kind === "move" ? `Перенос ${leaf}` : `${KIND_LABEL[job.kind]} ${leaf}`,
    status,
    progress: Math.min(1, Math.max(0, job.progress.percent / 100)),
    processedBytes: job.progress.processedBytes,
    totalBytes: job.progress.totalBytes,
    speed: job.progress.speed,
    eta: job.progress.etaSeconds ?? 8_640_000,
    currentFile: job.progress.currentFile || null,
    host: HOST_LABEL[job.host],
    diskLabel: job.payload.diskId || null,
    outputPath: job.payload.destination || job.payload.source || null,
    error: job.lastError,
    capabilities: { pause: true, resume: true, cancel: true },
    pauseUnsupportedReason: null,
    updatedAt: Date.parse(job.updatedAt) || Date.now(),
  };
}
