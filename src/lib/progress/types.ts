export type JobKind = "torrent" | "index" | "copy" | "compact" | "transcode" | "optical";

export type JobStatus = "running" | "paused" | "queued" | "completed" | "error" | "cancelled";

export interface JobCapabilities {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
}

/**
 * One long operation. Torrent jobs come from qBittorrent. Index, copy,
 * compact, and transcode come from their adapters — or from the demo engine
 * until Drive Manager, CompactGUI, and HandBrake are wired.
 */
export interface JobSnapshot {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  processedBytes: number;
  totalBytes: number;
  /** Bytes per second. 0 when the engine is not moving data. */
  speed: number;
  /** Seconds. A very large value means the ETA is unknown. */
  eta: number;
  currentFile: string | null;
  host: string | null;
  diskLabel: string | null;
  outputPath: string | null;
  error: string | null;
  capabilities: JobCapabilities;
  /** Shown when pause must stay hidden. Null when the engine can pause. */
  pauseUnsupportedReason: string | null;
  updatedAt: number;
}

export interface JobSource {
  id: string;
  list(): Promise<JobSnapshot[]> | JobSnapshot[];
}
