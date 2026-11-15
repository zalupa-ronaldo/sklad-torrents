import { diskStrip, isServiceVolume } from "@/addons/drives/inventory";
import type { DiskRecord, IndexCheckpoint, IndexPauseReason, IndexProcessPriority, IndexStrategy } from "@/addons/drives/types";
import { isIgnoredVolume } from "@/addons/drives/volume-letters";

export type IndexJobStatus = "queued" | "running" | "paused" | "complete" | "cancelled" | "error";

export interface IndexLoadPolicy {
  /** How many index jobs may read at once. */
  parallelism: number;
  /** Idle and below insert a gap between MFT chunks. The HTTP agent keeps its own priority. */
  processPriority: IndexProcessPriority;
  /** Do not index while the user is playing or working. */
  quiet: boolean;
  /** Local hours [start, end). A window that passes midnight is allowed. */
  quietHours: Array<{ startHour: number; endHour: number }>;
}

export interface IndexJob {
  id: string;
  label: string;
  priority: number;
  status: IndexJobStatus;
  pauseReason: IndexPauseReason | null;
  busy: boolean;
  service: boolean;
  ignored: boolean;
  manualOnly: boolean;
  strategy: IndexStrategy;
  currentFile: string | null;
  checkpoint: IndexCheckpoint;
  processedBytes: number;
  totalBytes: number;
  startedAt: number;
  updatedAt: number;
  sampleBytes: number;
  sampleAt: number;
  speed: number;
}

export interface IndexChunk {
  recordsDone: number;
  recordsTotal: number | null;
  mftOffset: number | null;
  nextUsn: string | null;
  currentFile: string | null;
  processedBytes: number;
  totalBytes: number;
}

export type IndexAction = "pause" | "resume" | "cancel" | "pause-all" | "resume-all" | "cancel-all";

const UNKNOWN_ETA = 8_640_000;

export function emptyCheckpoint(): IndexCheckpoint {
  return { recordsDone: 0, recordsTotal: null, mftOffset: null, nextUsn: null };
}

export function defaultIndexPolicy(): IndexLoadPolicy {
  return { parallelism: 1, processPriority: "below", quiet: false, quietHours: [] };
}

export function normalizeIndexPolicy(input: unknown): IndexLoadPolicy {
  const base = defaultIndexPolicy();
  if (!input || typeof input !== "object") return base;
  const raw = input as Record<string, unknown>;
  const parallelism = Math.floor(Number(raw.parallelism));
  if (Number.isFinite(parallelism)) base.parallelism = Math.min(4, Math.max(1, parallelism));
  if (raw.processPriority === "idle" || raw.processPriority === "below" || raw.processPriority === "normal") {
    base.processPriority = raw.processPriority;
  }
  base.quiet = raw.quiet === true;
  if (Array.isArray(raw.quietHours)) {
    for (const item of raw.quietHours) {
      if (!item || typeof item !== "object") continue;
      const start = Math.floor(Number((item as { startHour?: unknown }).startHour));
      const end = Math.floor(Number((item as { endHour?: unknown }).endHour));
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start < 0 || start > 23 || end < 0 || end > 24 || start === end) continue;
      base.quietHours.push({ startHour: start, endHour: end });
    }
  }
  return base;
}

/** Gap between MFT chunks. Quiet yields the most. This does not change the agent process priority. */
export function chunkGapMs(policy: IndexLoadPolicy): number {
  if (policy.quiet) return 200;
  if (policy.processPriority === "idle") return 50;
  if (policy.processPriority === "below") return 8;
  return 0;
}

export function quietActive(policy: IndexLoadPolicy, now: Date): boolean {
  if (policy.quiet) return true;
  const hour = now.getHours();
  return policy.quietHours.some((window) => {
    if (window.startHour < window.endHour) return hour >= window.startHour && hour < window.endHour;
    return hour >= window.startHour || hour < window.endHour;
  });
}

function held(job: IndexJob): boolean {
  return job.pauseReason === "user" || job.pauseReason === "restart";
}

/** A running job that died with the process stays paused and keeps its cursor. */
export function reopenAfterRestart(jobs: readonly IndexJob[]): IndexJob[] {
  return jobs.map((job) => {
    if (job.ignored) return { ...job, status: "cancelled", pauseReason: null, speed: 0 };
    if (job.status !== "running") return { ...job, checkpoint: { ...job.checkpoint } };
    return { ...job, status: "paused", pauseReason: "restart", speed: 0, checkpoint: { ...job.checkpoint } };
  });
}

/**
 * Picks who may read. User and restart pauses stay. Quiet and busy release themselves.
 * Ignored volumes are cancelled and never started. Service and manual-only volumes are not auto-started.
 */
export function scheduleIndex(jobs: readonly IndexJob[], policy: IndexLoadPolicy, now: Date): IndexJob[] {
  const quiet = quietActive(policy, now);
  const next = jobs.map((job) => ({ ...job, checkpoint: { ...job.checkpoint } }));
  for (const job of next) {
    if (job.ignored) {
      if (job.status === "queued" || job.status === "running" || job.status === "paused") {
        job.status = "cancelled";
        job.pauseReason = null;
        job.speed = 0;
      }
      continue;
    }
    if (job.status === "complete" || job.status === "cancelled" || job.status === "error") continue;
    if (held(job)) {
      job.status = "paused";
      job.speed = 0;
      continue;
    }
    if (quiet || job.busy) {
      job.status = "paused";
      job.pauseReason = quiet ? "quiet" : "busy";
      job.speed = 0;
      continue;
    }
    if (job.pauseReason === "quiet" || job.pauseReason === "busy") {
      job.status = "queued";
      job.pauseReason = null;
    }
  }
  const parallelism = Math.max(1, Math.floor(policy.parallelism) || 1);
  let slots = next.filter((job) => job.status === "running").length;
  const candidates = next
    .filter((job) => job.status === "queued" && !job.manualOnly && !job.service && !job.ignored && !job.busy)
    .sort((a, b) => b.priority - a.priority || a.updatedAt - b.updatedAt);
  for (const job of candidates) {
    if (slots >= parallelism) break;
    job.status = "running";
    job.pauseReason = null;
    if (!job.startedAt) job.startedAt = now.getTime();
    slots += 1;
  }
  return next;
}

export function controlIndex(jobs: readonly IndexJob[], id: string | null, action: IndexAction, now: number): IndexJob[] {
  const all = action === "pause-all" || action === "resume-all" || action === "cancel-all";
  return jobs.map((job) => {
    if (!all && job.id !== id) return { ...job, checkpoint: { ...job.checkpoint } };
    const next = { ...job, checkpoint: { ...job.checkpoint }, updatedAt: now };
    if (next.ignored) return { ...next, status: "cancelled", pauseReason: null, speed: 0 };
    if (action === "pause" || action === "pause-all") {
      if (next.status !== "running" && next.status !== "queued") return next;
      return { ...next, status: "paused", pauseReason: "user", speed: 0 };
    }
    if (action === "resume" || action === "resume-all") {
      if (next.status !== "paused") return next;
      return { ...next, status: "queued", pauseReason: null };
    }
    if (next.status === "complete" || next.status === "cancelled") return next;
    return { ...next, status: "cancelled", pauseReason: null, speed: 0 };
  });
}

export function noteIndexChunk(job: IndexJob, chunk: IndexChunk, now: number): IndexJob {
  const elapsed = job.sampleAt > 0 ? (now - job.sampleAt) / 1000 : 0;
  let speed = job.speed;
  let sampleBytes = job.sampleBytes;
  let sampleAt = job.sampleAt;
  if (elapsed >= 0.2 && chunk.processedBytes >= job.sampleBytes) {
    speed = (chunk.processedBytes - job.sampleBytes) / elapsed;
    sampleBytes = chunk.processedBytes;
    sampleAt = now;
  } else if (job.sampleAt === 0) {
    sampleBytes = chunk.processedBytes;
    sampleAt = now;
  }
  return {
    ...job,
    currentFile: chunk.currentFile,
    processedBytes: chunk.processedBytes,
    totalBytes: chunk.totalBytes,
    speed,
    sampleBytes,
    sampleAt,
    updatedAt: now,
    checkpoint: {
      recordsDone: chunk.recordsDone,
      recordsTotal: chunk.recordsTotal,
      mftOffset: chunk.mftOffset,
      nextUsn: chunk.nextUsn,
    },
  };
}

export function jobProgress(job: IndexJob): {
  progress: number;
  speed: number;
  eta: number;
  currentFile: string | null;
  processedBytes: number;
  totalBytes: number;
} {
  const totalRecords = job.checkpoint.recordsTotal;
  const progress = job.status === "complete"
    ? 1
    : totalRecords && totalRecords > 0
      ? Math.min(1, job.checkpoint.recordsDone / totalRecords)
      : job.totalBytes > 0
        ? Math.min(1, job.processedBytes / job.totalBytes)
        : 0;
  const speed = job.status === "running" ? job.speed : 0;
  const remaining = Math.max(0, job.totalBytes - job.processedBytes);
  const eta = speed > 0 && remaining > 0 ? Math.round(remaining / speed) : UNKNOWN_ETA;
  return {
    progress,
    speed,
    eta,
    currentFile: job.currentFile,
    processedBytes: job.processedBytes,
    totalBytes: job.totalBytes,
  };
}

export function queueProgress(jobs: readonly IndexJob[]): {
  progress: number;
  processedBytes: number;
  totalBytes: number;
  active: number;
  paused: number;
  queued: number;
} {
  const open = jobs.filter((job) => job.status === "running" || job.status === "paused" || job.status === "queued");
  const processedBytes = open.reduce((sum, job) => sum + job.processedBytes, 0);
  const totalBytes = open.reduce((sum, job) => sum + Math.max(job.totalBytes, job.processedBytes), 0);
  return {
    progress: totalBytes > 0 ? processedBytes / totalBytes : 0,
    processedBytes,
    totalBytes,
    active: jobs.filter((job) => job.status === "running").length,
    paused: jobs.filter((job) => job.status === "paused").length,
    queued: jobs.filter((job) => job.status === "queued").length,
  };
}

/**
 * A partial MFT pass accumulates beside the published tree.
 * The published tree changes only when the pass completes, and an empty completion does not wipe it.
 */
export function mergeIndexFiles<T>(
  published: readonly T[],
  partial: readonly T[],
  incoming: readonly T[],
  complete: boolean,
): { published: T[]; partial: T[] } {
  const partialNext = [...partial, ...incoming];
  if (!complete) return { published: [...published], partial: partialNext };
  if (partialNext.length === 0) return { published: [...published], partial: [] };
  return { published: partialNext, partial: [] };
}

export function disksToIndexJobs(disks: readonly DiskRecord[]): IndexJob[] {
  return disks.filter((disk) => !isIgnoredVolume(disk) && !isServiceVolume(disk)).map((disk) => {
    const status = disk.scan.status === "idle"
      ? "queued"
      : disk.scan.status === "error"
        ? "error"
        : disk.scan.status;
    return jobTemplate({
      id: disk.id,
      label: diskStrip(disk).title,
      priority: disk.scan.priority ?? 0,
      status,
      pauseReason: disk.scan.pauseReason ?? null,
      strategy: disk.scan.strategy,
      currentFile: disk.scan.currentFile ?? null,
      checkpoint: disk.scan.checkpoint ?? emptyCheckpoint(),
      processedBytes: disk.scan.processedBytes ?? 0,
      totalBytes: disk.scan.totalBytes ?? disk.totalBytes,
      speed: disk.scan.speed ?? 0,
      updatedAt: disk.scan.updatedAt ?? 0,
      startedAt: disk.scan.updatedAt ?? 0,
    });
  });
}

export function jobTemplate(partial: Pick<IndexJob, "id" | "label"> & Partial<IndexJob>): IndexJob {
  const checkpoint = partial.checkpoint;
  return {
    priority: 0,
    status: "queued",
    pauseReason: null,
    busy: false,
    service: false,
    ignored: false,
    manualOnly: false,
    strategy: "mft-usn",
    currentFile: null,
    processedBytes: 0,
    totalBytes: 0,
    startedAt: 0,
    updatedAt: 0,
    sampleBytes: 0,
    sampleAt: 0,
    speed: 0,
    ...partial,
    checkpoint: { ...emptyCheckpoint(), ...checkpoint },
  };
}
