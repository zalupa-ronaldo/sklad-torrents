import { registerJobSource } from "@/lib/progress/sources";
import type { JobKind, JobSnapshot, JobStatus } from "@/lib/progress/types";
import { QbittorrentError } from "@/lib/qbittorrent/errors";

const PAUSE_UNSUPPORTED = "Движок не умеет паузу";

registerJobSource({
  id: "sklad-queue",
  async list() {
    const { createJobStore } = await import("@/lib/jobs/engine");
    const { dataDir } = await import("@/lib/qbittorrent/store");
    const page = await createJobStore(dataDir()).list({ limit: 100 });
    return page.jobs.map(engineSnapshot);
  },
});

registerJobSource({
  id: "kernel-jobs",
  async list() {
    try {
      const { listJobs } = await import("@/lib/kernel/jobs");
      return (await listJobs()).map(kernelSnapshot);
    } catch {
      return [];
    }
  },
});

registerJobSource({
  id: "media-tools",
  async list() {
    try {
      const { loadJobs } = await import("@/addons/media-games/store");
      return (await loadJobs()).map(toolSnapshot);
    } catch {
      return [];
    }
  },
});

export async function performKernelAction(id: string, action: "pause" | "resume" | "cancel"): Promise<{ notice?: string }> {
  const { pauseJob, resumeJob, cancelJob } = await import("@/lib/kernel/jobs");
  try {
    if (action === "pause") await pauseJob(id);
    else if (action === "resume") await resumeJob(id);
    else {
      await cancelJob(id);
      return { notice: "Остановлено. Файлы на диске не удалялись." };
    }
    return {};
  } catch (error) {
    throw new QbittorrentError("validation", error instanceof Error && error.message ? error.message : PAUSE_UNSUPPORTED);
  }
}

function engineSnapshot(job: {
  id: string;
  kind: string;
  host: string;
  state: string;
  verified: boolean;
  cancelled: boolean;
  lastError: string | null;
  updatedAt: string;
  payload: { source: string; destination: string; diskId: string };
  progress: { percent: number; processedBytes: number; totalBytes: number; speed: number; etaSeconds: number | null; currentFile: string };
}): JobSnapshot {
  const status: JobStatus = job.cancelled
    ? "cancelled"
    : job.state === "done"
      ? "completed"
      : job.state === "error"
        ? "error"
        : job.state === "paused"
          ? "paused"
          : job.state === "queued"
            ? "queued"
            : "running";
  const kind: JobKind = job.kind === "transcode" ? "transcode" : job.kind === "compact" ? "compact" : job.kind === "index" ? "index" : "copy";
  return {
    id: job.id,
    kind,
    title: job.payload.diskId.startsWith("game:") ? "Подготовка игры" : kind,
    status,
    progress: Math.max(0, Math.min(1, job.progress.percent / 100)),
    processedBytes: job.progress.processedBytes,
    totalBytes: job.progress.totalBytes,
    speed: status === "running" ? job.progress.speed : 0,
    eta: job.progress.etaSeconds ?? 8_640_000,
    currentFile: job.progress.currentFile || job.payload.source,
    host: job.host,
    diskLabel: null,
    outputPath: job.payload.destination,
    error: status === "error" ? job.lastError : null,
    capabilities: {
      pause: status === "queued" || status === "running",
      resume: status === "paused",
      cancel: status === "queued" || status === "running" || status === "paused",
    },
    pauseUnsupportedReason: null,
    updatedAt: Date.parse(job.updatedAt) || Date.now(),
  };
}

function kernelSnapshot(job: {
  id: string;
  kind: string;
  hostId: string;
  title: string;
  source: string;
  destination: string;
  state: string;
  pauseSupported: boolean;
  cancelSupported: boolean;
  pauseRefusal: string;
  message: string;
  updatedAt: number;
  payload: Record<string, unknown>;
  progress: { currentFile: string; processedBytes: number; totalBytes: number; speedBps: number; etaSeconds: number | null; percent: number };
}): JobSnapshot {
  const cancelled = job.payload.cancelled === true;
  const status: JobStatus = cancelled
    ? "cancelled"
    : job.state === "done"
      ? "completed"
      : job.state === "error"
        ? "error"
        : job.state === "paused"
          ? "paused"
          : job.state === "queued"
            ? "queued"
            : "running";
  return {
    id: `kernel__${job.id}`,
    kind: kernelKind(job.kind),
    title: job.title,
    status,
    progress: clamp01(job.progress.percent),
    processedBytes: job.progress.processedBytes,
    totalBytes: job.progress.totalBytes,
    speed: status === "running" ? job.progress.speedBps : 0,
    eta: job.progress.etaSeconds ?? 8_640_000,
    currentFile: job.progress.currentFile || null,
    host: hostName(job.hostId),
    diskLabel: null,
    outputPath: job.destination || job.source,
    error: status === "error" ? job.message || "Ошибка задания" : null,
    capabilities: {
      pause: job.pauseSupported,
      resume: job.pauseSupported,
      cancel: job.cancelSupported,
    },
    pauseUnsupportedReason: job.pauseSupported ? null : job.pauseRefusal ? `${PAUSE_UNSUPPORTED}. ${job.pauseRefusal}` : PAUSE_UNSUPPORTED,
    updatedAt: job.updatedAt,
  };
}

function toolSnapshot(job: {
  id: string;
  kind: string;
  hostId: string;
  state: string;
  progress: number;
  title: string;
  updatedAt: number;
  error: string | null;
  inputPath: string | null;
  outputPath: string | null;
  sourcePath: string | null;
  destinationPath: string | null;
  folderPath: string | null;
  bytesBefore: number | null;
  copyBytes: number | null;
}): JobSnapshot {
  const kind = toolKind(job.kind);
  const status = toolStatus(job.state);
  const total = job.bytesBefore ?? job.copyBytes ?? 0;
  const progress = clamp01(job.progress);
  return {
    id: `tools__${job.id}`,
    kind,
    title: job.title,
    status,
    progress,
    processedBytes: total > 0 ? Math.round(total * progress) : 0,
    totalBytes: total,
    speed: 0,
    eta: 8_640_000,
    currentFile: job.inputPath || job.folderPath || job.sourcePath,
    host: hostName(job.hostId),
    diskLabel: null,
    outputPath: job.outputPath || job.destinationPath,
    error: job.error,
    capabilities: { pause: false, resume: false, cancel: false },
    pauseUnsupportedReason:
      kind === "transcode" || kind === "compact" ? `${PAUSE_UNSUPPORTED}. ${kind === "compact" ? "compact.exe не умеет паузу." : "HandBrakeCLI из Склада нельзя поставить на паузу."}` : PAUSE_UNSUPPORTED,
    updatedAt: job.updatedAt,
  };
}

function kernelKind(kind: string): JobKind {
  if (kind === "index") return "index";
  if (kind === "compact") return "compact";
  if (kind === "transcode") return "transcode";
  return "copy";
}

function toolKind(kind: string): JobKind {
  if (kind === "transcode") return "transcode";
  if (kind === "compress") return "compact";
  return "copy";
}

function toolStatus(state: string): JobStatus {
  if (state === "completed") return "completed";
  if (state === "failed") return "error";
  if (state === "cancelled") return "cancelled";
  if (state === "queued" || state === "awaiting-confirm") return "queued";
  if (state === "running" || state === "verifying") return "running";
  return "paused";
}

function hostName(hostId: string): string {
  if (hostId === "demo-mac" || hostId === "mac-local") return "Mac mini";
  if (hostId === "demo-pc" || hostId === "pc-agent") return "Windows PC";
  return hostId;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
