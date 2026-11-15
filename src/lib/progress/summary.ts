import type { JobSnapshot, JobStatus } from "@/lib/progress/types";

const OPEN: ReadonlySet<JobStatus> = new Set(["running", "paused", "queued"]);

export interface QueueSummary {
  percent: number;
  speed: number;
  eta: number;
  currentFile: string | null;
  running: number;
  paused: number;
  queued: number;
  bytesDone: number;
  bytesTotal: number;
}

export function summarize(jobs: readonly JobSnapshot[]): QueueSummary {
  const open = jobs.filter((job) => OPEN.has(job.status));
  let bytesDone = 0;
  let bytesTotal = 0;
  let speed = 0;
  let running = 0;
  let paused = 0;
  let queued = 0;
  for (const job of open) {
    if (job.status === "running") running += 1;
    else if (job.status === "paused") paused += 1;
    else queued += 1;
    const total = Math.max(0, job.totalBytes);
    const done = Math.max(0, Math.min(job.processedBytes, total || job.processedBytes));
    if (total > 0) {
      bytesTotal += total;
      bytesDone += Math.min(done, total);
    }
    if (job.status === "running") speed += Math.max(0, job.speed);
  }
  const percent = bytesTotal > 0
    ? Math.min(1, bytesDone / bytesTotal)
    : open.length === 0
      ? 0
      : open.reduce((sum, job) => sum + clamp01(job.progress), 0) / open.length;
  const remain = Math.max(0, bytesTotal - bytesDone);
  const eta = speed > 0 && bytesTotal > 0 ? Math.round(remain / speed) : 8_640_000;
  const current = open.find((job) => job.status === "running" && job.currentFile) ?? open.find((job) => job.currentFile);
  return {
    percent,
    speed,
    eta,
    currentFile: current?.currentFile ?? null,
    running,
    paused,
    queued,
    bytesDone,
    bytesTotal,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
