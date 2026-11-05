import type { HostOs } from "@/lib/qbittorrent/types";

export type Filesystem = "ntfs" | "apfs" | "hfs" | "exfat" | "other";

export type ContentKind =
  | "game-pc"
  | "game-console"
  | "game-psp"
  | "game-other"
  | "movie"
  | "series"
  | "music"
  | "software"
  | "document"
  | "other";

export type JobKind = "index" | "copy" | "move" | "compact" | "transcode" | "delete-source";

export type JobState = "queued" | "running" | "paused" | "done" | "error";

export type IndexMethod = "mft" | "usn" | "walk";

export type CompactAlgorithm = "LZX" | "XPRESS8K" | "XPRESS16K" | "XPRESS4K";

export const COMPACT_ALGORITHMS: CompactAlgorithm[] = ["LZX", "XPRESS8K", "XPRESS16K", "XPRESS4K"];

export interface DiskMount {
  hostId: string;
  mountPoint: string;
}

export interface CatalogFile {
  path: string;
  size: number;
}

export interface LocatedItem {
  kind: "torrent" | "game" | "media";
  name: string;
  path: string;
}

export interface DiskRecord {
  id: string;
  serial: string;
  volumeUuid: string;
  filesystem: Filesystem;
  label: string;
  totalBytes: number;
  freeBytes: number;
  online: boolean;
  mounts: DiskMount[];
  lastMount: DiskMount | null;
  lastSeen: number;
  lastHostId: string | null;
  files: CatalogFile[];
  indexStatus: "idle" | "running" | "paused" | "complete" | "error";
  indexMethod: IndexMethod | null;
  indexError: string | null;
  indexedAt: number | null;
  heavyActivity: boolean;
  elevated: boolean;
  located: LocatedItem[];
}

export interface DiskProbe {
  serial: string;
  volumeUuid: string;
  filesystem: Filesystem;
  hostId: string;
  os: HostOs;
  /** All current mount points of this volume on this host. Letter and path are not identity. */
  mountPoints: string[];
  label?: string;
  totalBytes: number;
  freeBytes: number;
  online: boolean;
  elevated: boolean;
  heavyActivity?: boolean;
}

export interface JobProgress {
  currentFile: string;
  processedBytes: number;
  totalBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  percent: number;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  hostId: string;
  title: string;
  source: string;
  destination: string;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  attempts: number;
  maxAttempts: number;
  claimToken: string | null;
  claimedBy: string | null;
  version: number;
  idempotencyKey: string;
  pauseSupported: boolean;
  cancelSupported: boolean;
  pauseRefusal: string;
  message: string;
  progress: JobProgress;
  payload: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface SearchHit {
  diskId: string;
  label: string;
  online: boolean;
  filesystem: Filesystem;
  path: string;
  size: number;
  message: string;
}

export interface ToolSettings {
  handbrakePath: Record<HostOs, string>;
  compactExePath: string;
}

export interface LibraryEntry {
  id: string;
  name: string;
  source: string;
  destination: string;
  hostId: string;
  diskId: string | null;
  verified: boolean;
  /** Always false in the mock adapter. Real removal is a later agent milestone. */
  sourceDeleted: boolean;
  removalConfirmed: boolean;
  jobId: string;
}

export interface PolicyProfile {
  contentKind: ContentKind;
  diskId: string | null;
  folder: string;
  indexProfile: "full" | "names-only" | "none";
  postProcess: "none" | "ntfs-compact" | "handbrake";
  handbrake: { codec: string; quality: number } | null;
  /** NTFS compact is allowed only after a finished move, never as a plug-in side effect. */
  compactAfterMove: boolean;
}

export interface CustomRule {
  id: string;
  pattern: string;
  kind: ContentKind;
}

export interface PolicyFile {
  automationEnabled: boolean;
  lastDryRunAt: number | null;
  dryRunFingerprint: string | null;
  profiles: PolicyProfile[];
  customRules: CustomRule[];
}

export interface SchedulerPrefs {
  order: Record<string, string[]>;
  overrideNext: Record<string, string | null>;
  /** Torrents this scheduler parked so the per-disk cap holds. User pauses are not listed here. */
  schedulerPaused: string[];
}
