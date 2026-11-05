export const JOB_KINDS = ["move", "copy", "index", "compact", "transcode"] as const;
export const JOB_HOSTS = ["mac-local", "pc-agent"] as const;
export const JOB_STATES = ["queued", "running", "paused", "done", "error"] as const;

export type JobKind = (typeof JOB_KINDS)[number];
export type JobHost = (typeof JOB_HOSTS)[number];
export type JobState = (typeof JOB_STATES)[number];

export interface JobPayload {
  source: string;
  destination: string;
  diskId: string;
  torrentHash: string;
  handbrakeProfile: string;
  compactAlgorithm: string;
}

export interface JobProgress {
  percent: number;
  processedBytes: number;
  totalBytes: number;
  speed: number;
  etaSeconds: number | null;
  currentFile: string;
}

export interface Job {
  id: string;
  kind: JobKind;
  host: JobHost;
  state: JobState;
  payload: JobPayload;
  progress: JobProgress;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  verified: boolean;
  autoRetries: number;
  cancelled: boolean;
  sourceDeleted: boolean;
  workerToken: string | null;
}

export type PublicJob = Omit<Job, "workerToken">;

export interface JobCounts {
  queued: number;
  running: number;
  paused: number;
  done: number;
  error: number;
}

export interface JobList {
  jobs: Job[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  counts: JobCounts;
}

export interface PublicJobList {
  jobs: PublicJob[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  counts: JobCounts;
}

export type JobEvent =
  | { type: "snapshot"; counts: JobCounts; total: number }
  | { type: "upsert"; job: PublicJob; counts: JobCounts }
  | {
      type: "progress";
      job: PublicJob;
      counts: JobCounts;
      percent: number;
      processedBytes: number;
      totalBytes: number;
    };

export interface EnqueueInput {
  kind: JobKind;
  host: JobHost;
  source?: string;
  destination?: string;
  diskId?: string;
  torrentHash?: string;
  handbrakeProfile?: string;
  compactAlgorithm?: string;
}

export const ACTIVE_JOB_STATES: ReadonlySet<JobState> = new Set(["queued", "running", "paused"]);

export const MAX_AUTO_RETRIES = 2;
