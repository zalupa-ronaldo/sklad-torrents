export const HASH_STATUSES = ["pending", "hashing", "match", "mismatch", "error", "recorded"] as const;

export type HashStatus = (typeof HASH_STATUSES)[number];

export type IntegrityKind = "torrent" | "move" | "copy" | "localsend" | "compact" | "handbrake" | "optical";

export type IntegrityState = "queued" | "running" | "paused" | "cancelled" | "done" | "error";

export type HashSide = "source" | "destination";

/** One file inside a hash job. A mismatch or error never deletes the file. */
export interface HashFileRecord {
  relativePath: string;
  size: number;
  /** Lowercase hex, empty until the digest is stored. */
  sha256: string;
  status: HashStatus;
  bytesHashed: number;
  updatedAt: string;
  side: HashSide;
}

export interface HashCheckpoint {
  relativePath: string;
  /** Next byte to persist. SHA-256 still covers the whole file. */
  byteOffset: number;
}

export interface TorrentHashRecord {
  hostId: string;
  hash: string;
  name: string;
  files: HashFileRecord[];
  jobId: string;
  updatedAt: string;
}

export interface VerifiedDiscRecord {
  id: string;
  jobId: string;
  verified: true;
  rewritable: boolean;
  /** Rewritable media is never auto-erased. */
  erased: false;
  checksums: { relativePath: string; size: number; sha256: string }[];
  updatedAt: string;
}

export interface IntegrityJob {
  id: string;
  kind: IntegrityKind;
  state: IntegrityState;
  title: string;
  /** False for HandBrake: input and output are stored and must not be compared. */
  comparable: boolean;
  files: HashFileRecord[];
  checkpoint: HashCheckpoint | null;
  currentFile: string;
  filesDone: number;
  filesTotal: number;
  bytesHashed: number;
  bytesTotal: number;
  percent: number;
  speed: number;
  etaSeconds: number | null;
  transferDone: boolean;
  userConfirmed: boolean;
  deleteAllowed: boolean;
  deleteReason: string;
  mismatchPaths: string[];
  error: string | null;
  discVerified: boolean;
  sourceLabel: string;
  destinationLabel: string;
  torrentHostId: string;
  torrentHash: string;
  torrentName: string;
  rewritable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrityFile {
  version: 1;
  jobs: IntegrityJob[];
  torrents: TorrentHashRecord[];
  discs: VerifiedDiscRecord[];
}

export const HASH_STATUS_LABEL: Record<HashStatus, string> = {
  pending: "ожидает",
  hashing: "считается",
  match: "совпал",
  mismatch: "отличается",
  error: "ошибка",
  recorded: "записан",
};
