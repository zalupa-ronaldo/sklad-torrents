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
  size: number;
  mtimeMs: number;
  sidecarCategory?: MediaCategory | null;
}

export interface IndexedFile {
  relativePath: string;
  name: string;
  kind: "file" | "dir";
  size: number;
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
  state: ScanStatus;
  progress: number;
  message?: string;
  strategy?: IndexStrategy;
  files?: RawIndexedFile[];
  delta?: IndexDelta;
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
  categoryCounts: Record<MediaCategory, number>;
}

export interface ShelfResponse {
  mode: DriveMode;
  readOnly: true;
  disks: DiskView[];
  agentErrors: { hostName: string; message: string }[];
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
