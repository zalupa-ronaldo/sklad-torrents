export type JobStatus = "queued" | "running" | "paused" | "done" | "error";

/** Shared background job. Optical burns use this queue; other modules can too. */
export interface BackgroundJob {
  id: string;
  kind: string;
  status: JobStatus;
  phase: string;
  percent: number;
  currentFile: string | null;
  bytesDone: number | null;
  bytesTotal: number | null;
  title: string;
  error: string | null;
  /** True when a mock runner produced the result. Never means the hardware succeeded. */
  mock: boolean;
  /** True only after a non-mock tool run that actually finished its success path. */
  hardware: boolean;
  idempotencyKey: string;
  /** Optical hardware jobs use `pc-agent`. Other queues may leave this empty. */
  host?: string;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown>;
}

export const ACTIVE_JOB: ReadonlySet<JobStatus> = new Set(["queued", "running", "paused"]);

/** File-transfer queue used by LocalSend. Separate from BackgroundJob. */
export type JobState = "queued" | "running" | "paused" | "done" | "error";

export interface JobProgress {
  bytesDone: number;
  bytesTotal: number;
  fileName: string | null;
  startedAt: number | null;
  percent: number;
}

export function emptyProgress(bytesTotal = 0): JobProgress {
  return { bytesDone: 0, bytesTotal, fileName: null, startedAt: null, percent: 0 };
}

export function progressSnapshot(
  bytesDone: number,
  bytesTotal: number,
  startedAt: number | null,
  fileName: string | null,
): JobProgress {
  const total = Math.max(0, bytesTotal);
  const done = Math.max(0, Math.min(bytesDone, total || bytesDone));
  const percent = total === 0 ? (done > 0 ? 100 : 0) : Math.min(100, Math.round((done / total) * 100));
  return { bytesDone: done, bytesTotal: total, fileName, startedAt, percent };
}

export interface JobRecord<T = unknown> {
  id: string;
  kind: string;
  state: JobState;
  idempotencyKey: string;
  title: string;
  message?: string;
  progress: JobProgress;
  error: string | null;
  note: string | null;
  payload: T;
  sessionId: string | null;
  control: "pause" | "cancel" | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}
