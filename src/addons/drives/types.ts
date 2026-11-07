export type HostOs = "darwin" | "win32";
export type PathStyle = "posix" | "win32";
export type MediaCategory = "torrent" | "game" | "media" | "series" | "installer" | "music" | "software" | "documents";
export type IndexStrategy = "mft-usn" | "walk";
export type ScanStatus = "idle" | "running" | "paused" | "complete" | "error";
export type DriveMode = "mock" | "agents";

export interface LibraryRule {
  prefix: string;
  category: MediaCategory;
}

export interface RawIndexedFile {
  relativePath: string;
  name: string;
  kind: "file" | "dir";
  /** Logical length. Null means the snapshot did not say — unknown, not an empty file. */
  size: number | null;
  /** Allocated length of the unnamed $DATA stream. Not the WOF compressed size. */
  allocated?: number;
  /** Bytes occupied on disk when the scanner measured them. Absent means unknown, not zero. */
  onDisk?: number;
  /** Set only when compression itself was identified. */
  compression?: "wof" | "ntfs";
  mtimeMs: number;
  sidecarCategory?: MediaCategory | null;
}

export interface IndexedFile {
  relativePath: string;
  name: string;
  kind: "file" | "dir";
  /** Logical length. Null means unknown, not a real empty file. */
  size: number | null;
  /** Allocated length of the unnamed $DATA stream. Not the WOF compressed size. */
  allocated?: number;
  /** Measured size on disk. Absent means unknown, not zero. */
  onDisk?: number;
  compression?: "wof" | "ntfs";
  mtimeMs: number;
  sidecarCategory: MediaCategory | null;
  categories: MediaCategory[];
}

export interface IndexDelta {
  upserts: RawIndexedFile[];
  deletes: string[];
  complete: boolean;
}

export interface IndexPayload {
  revision?: string;
  recordCount?: number;
  state: ScanStatus;
  progress: number;
  message?: string;
  strategy?: IndexStrategy;
  files?: RawIndexedFile[];
  delta?: IndexDelta;
  /** Large snapshot is downloaded off the shelf request. Not sent by the agent. */
  deferred?: boolean;
}

export interface ScanState {
  status: ScanStatus;
  strategy: IndexStrategy;
  progress: number;
  message: string;
  elevated: boolean;
}

export interface ConnectedHost {
  id: string;
  name: string;
  os: HostOs;
  elevated: boolean;
  mountPaths: string[];
}

export interface DiskRecord {
  indexRevision?: string;
  id: string;
  serial: string;
  serialNorm: string;
  volumeUuid: string;
  uuidNorm: string;
  filesystem: string;
  label: string;
  namedByUser: boolean;
  volumeName: string;
  totalBytes: number;
  freeBytes: number;
  lastSeenAt: string;
  lastHostId: string;
  lastHostName: string;
  pathStyle: PathStyle;
  lastMountPath: string;
  priorMountPath: string;
  connectedHosts: ConnectedHost[];
  duplicateMounts: boolean;
  possibleClone: boolean;
  cloneOfIds: string[];
  scan: ScanState;
  files: IndexedFile[];
  /** Exact totals from one pass over files. Shelf reads this and does not walk the array. */
  summary?: DiskSummary;
  /** Agent record count before the local file list is ready. Not a substitute for summary.indexedBytes. */
  reportedRecords?: number;
  pendingRevision?: string;
  /** NDJSON file holding files when the catalog is too large to stringify in one string. */
  fileStore?: string;
  /** Agent or stored revision already written into fileStore. Same value means the shard must not be rewritten. */
  shardRevision?: string;
  /** Byte size of fileStore. A non-empty shard is a real index even when the summary was saved as zero. */
  shardBytes?: number;
}

export interface DiskSummary {
  fileCount: number;
  indexedBytes: number;
  categoryCounts: Record<MediaCategory, number>;
  /** Files whose logical size was missing. They are not counted as 0 bytes. */
  unknownSizes?: number;
}

export interface ObservedVolume {
  serial: string;
  volumeUuid: string;
  filesystem: string;
  volumeName: string;
  mountPaths: string[];
  totalBytes: number;
  freeBytes: number;
  busy: boolean;
  index?: IndexPayload | null;
}

export interface HostObservation {
  hostId: string;
  hostName: string;
  os: HostOs;
  elevated: boolean;
  volumes: ObservedVolume[];
}

export interface CollectedVolume {
  serial: string;
  volumeUuid: string;
  filesystem: string;
  volumeName: string;
  mountPaths: string[];
  totalBytes: number;
  freeBytes: number;
  busy: boolean;
  letter: string | null;
}

export interface AgentEndpoint {
  id: string;
  name: string;
  os: HostOs;
  url: string;
}

export interface DiskView {
  id: string;
  label: string;
  namedByUser: boolean;
  volumeName: string;
  serial: string;
  volumeUuid: string;
  filesystem: string;
  totalBytes: number;
  freeBytes: number;
  online: boolean;
  lastSeenAt: string;
  lastHostId: string;
  lastHostName: string;
  mountPaths: string[];
  lastMountPath: string;
  priorMountPath: string;
  duplicateMounts: boolean;
  possibleClone: boolean;
  clonePeerLabels: string[];
  scan: ScanState;
  fileCount: number;
  /** Sum of indexed file sizes. Folder totals in the browser are derived from the same bytes. */
  indexedBytes: number;
  /** False while a large index is still being totaled. Zero then is not a measured size. */
  sizesReady: boolean;
  /** False when file rows exist but their logical sizes were not in the snapshot. */
  sizesKnown?: boolean;
  categoryCounts: Record<MediaCategory, number>;
}

export interface ShelfResponse {
  mode: DriveMode;
  readOnly: true;
  disks: DiskView[];
  agentErrors: { hostId?: string; hostName: string; message: string }[];
}

export interface SearchHit {
  diskId: string;
  label: string;
  serial: string;
  volumeUuid: string;
  filesystem: string;
  online: boolean;
  path: string;
  name: string;
  kind: "file" | "dir";
  categories: MediaCategory[];
  connectHint: string | null;
  reachable: boolean;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
}

export class DriveError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DriveError";
    this.status = status;
  }
}
