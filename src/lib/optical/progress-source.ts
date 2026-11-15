import { readJobs } from "@/lib/jobs/store";
import type { BackgroundJob } from "@/lib/jobs/types";
import { bytesPerSecond, etaSeconds, fraction } from "@/lib/optical/progress-math";
import { registerJobSource } from "@/lib/progress/sources";
import type { JobSnapshot, JobStatus } from "@/lib/progress/types";

registerJobSource({
  id: "optical-dvd",
  async list() {
    const jobs = await readJobs();
    return jobs.filter((job) => job.kind.startsWith("optical.")).map((job) => toSnapshot(job));
  },
});

function toSnapshot(job: BackgroundJob, now = Date.now()): JobSnapshot {
  const status = mapStatus(job.status);
  const phase = job.phase && job.phase !== "ожидание" ? job.phase : "";
  const file = job.currentFile || "";
  const currentFile = [phase, file].filter(Boolean).join(" · ") || null;
  const open = status === "running" || status === "paused" || status === "queued";
  const elapsed = elapsedMs(job, now);
  const speed = status === "running" ? bytesPerSecond(job.bytesDone ?? 0, elapsed) : 0;
  return {
    id: `optical__${job.id}`,
    kind: "optical",
    title: job.mock ? `Демо · ${job.title}` : job.title,
    status,
    progress: fraction(job.bytesDone ?? 0, job.bytesTotal ?? 0, job.percent),
    processedBytes: job.bytesDone ?? 0,
    totalBytes: job.bytesTotal ?? 0,
    speed,
    eta: status === "running" ? etaSeconds(job.bytesDone ?? 0, job.bytesTotal ?? 0, speed) : 8_640_000,
    currentFile,
    host: job.host || (job.mock ? "демо" : "pc-agent"),
    diskLabel: job.mock ? "демо, не настоящий диск" : null,
    outputPath: typeof job.payload.isoPath === "string" ? job.payload.isoPath : null,
    error: status === "paused" ? null : job.error,
    capabilities: { pause: open, resume: open, cancel: open },
    pauseUnsupportedReason: null,
    updatedAt: Date.parse(job.updatedAt) || now,
  };
}

function elapsedMs(job: BackgroundJob, now: number): number {
  const stored = job.payload.elapsedMs;
  const base = typeof stored === "number" && stored > 0 ? stored : 0;
  const started = Date.parse(job.createdAt);
  if (!Number.isFinite(started)) return base;
  return Math.max(base, now - started);
}

function mapStatus(status: BackgroundJob["status"]): JobStatus {
  if (status === "done") return "completed";
  if (status === "error") return "error";
  if (status === "paused") return "paused";
  if (status === "running") return "running";
  return "queued";
}
