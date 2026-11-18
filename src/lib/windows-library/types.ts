/** Windows game library. The panel does not seed demo titles. */

export type LibraryOs = "win32" | "darwin";

export type FilesystemKind = "ntfs" | "exfat" | "fat" | "apfs" | "unknown";

export type WalkReason = "first-attach" | "journal-lost" | "history-dropped" | "fat";

export interface VolumeCursor {
  serial: string;
  uuid: string;
  os: LibraryOs;
  filesystem: FilesystemKind;
  letter: string | null;
  mount: string | null;
  attached: boolean;
  mftIndexed: boolean;
  walked: boolean;
  journalId: string | null;
  nextUsn: string | null;
  lastEventId: string | null;
  diskutilCached: boolean;
  mftTicket: boolean;
  usnTicket: boolean;
  walkTicket: WalkReason | null;
  diskutilTicket: boolean;
  awaitingJournalPin: boolean;
  pendingJournalId: string | null;
  pendingNextUsn: string | null;
  pendingEventId: string | null;
}

export interface VolumeIdentity {
  serial: string;
  uuid: string;
  os: LibraryOs;
  filesystem: FilesystemKind;
  letter: string | null;
  mount: string | null;
}

export type LibraryEvent =
  | { type: "poll" }
  | { type: "wmi"; eventType: number; identity: VolumeIdentity }
  | { type: "dbt"; code: number; identity: VolumeIdentity }
  | { type: "mac-appear"; identity: VolumeIdentity }
  | { type: "mac-disappear"; identity: VolumeIdentity }
  | { type: "fsevent"; identity: VolumeIdentity; eventId: string; historyDropped: boolean }
  | { type: "journal-info"; identity: VolumeIdentity; journalId: string; lowestValidUsn: string; nextUsn: string };

export type IndexAction =
  | { type: "ignore"; reason: string }
  | { type: "detach"; reason: string }
  | { type: "read-mft"; reason: string }
  | { type: "query-usn"; ioctl: number; reason: string }
  | { type: "read-usn"; ioctl: number; journalId: string; startUsn: string; reason: string }
  | { type: "walk-once"; reason: WalkReason }
  | { type: "diskutil-info-once"; reason: string }
  | { type: "refuse"; reason: string };

export interface IndexedEntry {
  relativePath: string;
  name: string;
  isDirectory: boolean;
  logicalBytes: number | null;
  allocatedBytes: number | null;
  compressed: boolean | null;
  algorithm: string | null;
}

export interface IndexNode {
  fileRef: string;
  parentRef: string;
  name: string;
  isDirectory: boolean;
  logicalBytes: number | null;
  allocatedBytes: number | null;
  compressed: boolean | null;
  algorithm: string | null;
}

export type LauncherKind = "steam" | "epic" | "gog" | "folder";

export type CompressionState = "uncompressed" | "compressed" | "mixed" | "unknown" | "queued";

export interface CoverRef {
  cacheKey: string;
  source: "cache" | "steam-app" | "steamgriddb" | "name";
  url: string | null;
  cached: boolean;
}

export interface WinGame {
  id: string;
  title: string;
  launcher: LauncherKind;
  steamAppId: number | null;
  root: string;
  installdir: string | null;
  manifestPath: string | null;
  libraryFoldersPath: string | null;
  serial: string;
  uuid: string;
  archiveRoot: string;
  archiveSerial: string;
  archiveUuid: string;
  logicalBytes: number | null;
  allocatedBytes: number | null;
  compression: CompressionState;
  algorithm: string | null;
  cover: CoverRef;
  pool: "archive" | "playing";
  online: boolean;
}

export interface FastSsd {
  serial: string;
  uuid: string;
  root: string;
}

export interface LibrarySettings {
  fastSsd: FastSsd | null;
}

export type LibraryJobKind = "compress" | "play" | "return";

export type LibraryJobState = "queued" | "running" | "done" | "error" | "needs-confirm";

export interface LibraryJob {
  id: string;
  kind: LibraryJobKind;
  gameId: string;
  state: LibraryJobState;
  phase: string;
  percent: number;
  confirm: boolean;
  error: string | null;
  sourceDeleted: boolean;
  verified: boolean;
  compactAlgorithm: string | null;
  phases: string[];
  sourceRoot: string;
  destRoot: string;
  destLibrary: string | null;
  manifestPath: string | null;
  libraryFoldersPath: string | null;
  installdir: string | null;
  steamAppId: number | null;
  launcher: LauncherKind;
}

export interface CoverCacheEntry {
  source: CoverRef["source"];
  url: string | null;
  cachedAt: string;
}

export interface VolumeIndex {
  key: string;
  nodes: IndexNode[];
  /** Set by the one allowed directory listing. Null while the MFT node tree is authoritative. */
  flat: IndexedEntry[] | null;
  unplaced: number;
}

export interface CatalogFile {
  volumeKey: string;
  relativePath: string;
  text: string;
}

export interface LibraryState {
  volumes: VolumeCursor[];
  indexes: VolumeIndex[];
  catalog: CatalogFile[];
  games: WinGame[];
  jobs: LibraryJob[];
  settings: LibrarySettings;
  covers: Record<string, CoverCacheEntry>;
}

export interface PublicLibraryJob {
  id: string;
  kind: LibraryJobKind;
  gameId: string;
  state: LibraryJobState;
  phase: string;
  percent: number;
  error: string | null;
  sourceDeleted: boolean;
  verified: boolean;
  compactAlgorithm: string | null;
}

export interface PublicWindowsGame {
  id: string;
  title: string;
  launcher: LauncherKind;
  steamAppId: number | null;
  root: string;
  serial: string;
  uuid: string;
  logicalBytes: number | null;
  allocatedBytes: number | null;
  compression: CompressionState;
  algorithm: string | null;
  cover: CoverRef;
  pool: "archive" | "playing";
  online: boolean;
  job: PublicLibraryJob | null;
}

export interface PublicVolume {
  serial: string;
  uuid: string;
  os: LibraryOs;
  filesystem: FilesystemKind;
  letter: string | null;
  attached: boolean;
  mftIndexed: boolean;
  walked: boolean;
  journalId: string | null;
  nextUsn: string | null;
  lastEventId: string | null;
  diskutilCached: boolean;
  index: "mft" | "usn" | "walk" | "none";
  unplaced: number;
}

export interface LibraryView {
  games: PublicWindowsGame[];
  volumes: PublicVolume[];
  settings: LibrarySettings;
  /** Inventory never polls. */
  polling: false;
}
