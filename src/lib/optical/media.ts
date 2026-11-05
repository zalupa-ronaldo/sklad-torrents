export type MediaProfile = "cd" | "dvd-sl" | "dvd-dl";

export type MediaKind =
  | "empty"
  | "cd"
  | "cd-rw"
  | "dvd-r"
  | "dvd+r"
  | "dvd-rw"
  | "dvd+rw"
  | "dvd-r-dl"
  | "dvd+r-dl"
  | "unknown";

export type DiscSource = "mock" | "tool";

export type OpticalPhase = "образ" | "запись" | "проверка";

export type OpticalAction = "iso" | "burn" | "erase";

export interface IndexedPath {
  diskLabel: string;
  path: string;
  name: string;
  size: number;
  kind: "file" | "folder";
}

export interface OpticalDrive {
  id: string;
  name: string;
  device: string;
  driveIndex: string | null;
  location: "internal" | "external" | "unknown";
  media: MediaKind;
  volumeName: string | null;
  /** Filesystem UUID reported by the OS. Not a hardware serial. */
  volumeUuid: string | null;
  hardwareSerial: string | null;
  rewritable: boolean;
  suggestedProfile: MediaProfile | null;
  demo: boolean;
  platform: "darwin" | "win32";
  recorderId: string | null;
}

export interface OpticalStep {
  phase: OpticalPhase;
  argv: string[];
  currentFile: string | null;
}

export interface OpticalPayload {
  action: OpticalAction;
  profile: MediaProfile | null;
  driveId: string | null;
  driveName: string | null;
  device: string | null;
  platform: "darwin" | "win32";
  media: MediaKind;
  files: IndexedPath[];
  isoPath: string | null;
  outputDir: string | null;
  label: string;
  locationNote: string;
  /** Passed to the burner only when the user confirmation was stored on the job. */
  erase: boolean;
  eraseConfirmed: boolean;
  demo: boolean;
  /** Volume UUID reported by the drive, if the OS actually printed one. */
  volumeUuid: string | null;
  /** True only after the verify command actually ran and exited 0. */
  verified: boolean;
  source: DiscSource | null;
  steps: OpticalStep[];
  totalBytes: number;
}

export interface BurnedDisc {
  id: string;
  idOrigin: "generated" | "media";
  hardwareSerial: null;
  label: string;
  locationNote: string;
  profile: MediaProfile;
  media: MediaKind;
  files: IndexedPath[];
  source: DiscSource;
  jobId: string;
  createdAt: string;
  bytes: number;
}

export interface SearchHit {
  discId: string;
  label: string;
  locationNote: string;
  fileName: string;
  filePath: string;
  source: DiscSource;
  offline: boolean;
  message: string;
}

export interface DetectResult {
  status: "ok" | "no-drive" | "demo";
  drives: OpticalDrive[];
  detail: string;
}
