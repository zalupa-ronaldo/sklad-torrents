export type ToolHostId = "mac-local" | "pc-agent";
export type ToolOs = "darwin" | "win32";
export type JobKind = "transcode" | "move" | "compress";
export type JobState =
  | "queued"
  | "running"
  | "verifying"
  | "awaiting-confirm"
  | "completed"
  | "failed"
  | "cancelled";
export type JobRunner = "mock" | "local" | "pc-agent";
export type CompactAlgorithm = "LZX" | "XPRESS16K" | "XPRESS8K" | "XPRESS4K";
export type LibraryStatus = "verified" | "moved";

export interface ToolHostConfig {
  id: ToolHostId;
  name: string;
  os: ToolOs;
  /** Base URL of agents/pc-agent. Mac host keeps this empty. */
  agentUrl: string | null;
  handbrakePath: string;
  /** Alternate exe, Homebrew path, or a Linux flatpak id. Not used as the Windows launcher. */
  handbrakeExtra: string;
  compactPath: string;
  compactGuiPath: string;
  libraryFolders: string[];
}

export interface ToolsConfig {
  /** When true, jobs advance in-process and no HandBrake or compact.exe is spawned. */
  demoMode: boolean;
  hosts: ToolHostConfig[];
}

export interface VerifyResult {
  ok: boolean;
  sourceFiles: number;
  destFiles: number;
  sourceBytes: number;
  destBytes: number;
  sourceHash: string;
  destHash: string;
  message: string;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  hostId: ToolHostId;
  state: JobState;
  progress: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  runner: JobRunner;
  plannedArgv: string[];
  binaryFound: boolean | null;
  outputMarker: string | null;
  inputPath: string | null;
  outputPath: string | null;
  presetId: string | null;
  presetLabel: string | null;
  sourcePath: string | null;
  destinationPath: string | null;
  folderPath: string | null;
  algorithm: CompactAlgorithm | null;
  verified: boolean;
  /** Stays false until the copy is verified and the user confirms deletion. */
  deleteSource: boolean;
  sourceDeleted: boolean;
  verify: VerifyResult | null;
  bytesBefore: number | null;
  bytesAfter: number | null;
  libraryId: string | null;
  copyFiles: number | null;
  copyBytes: number | null;
  /** True only after a real process spawn. Mock jobs stay false. */
  spawned: boolean;
  remoteId: string | null;
}

export interface LibraryRecord {
  id: string;
  name: string;
  hostId: ToolHostId;
  oldPath: string;
  newPath: string;
  status: LibraryStatus;
  jobId: string;
  updatedAt: number;
}

export interface HostProbe {
  id: ToolHostId;
  name: string;
  os: ToolOs;
  handbrakePath: string;
  handbrakeFound: boolean;
  handbrakeCandidates: string[];
  compactPath: string;
  compactFound: boolean;
  compactAvailable: boolean;
  compactReason: string | null;
  discoveryNote: string;
}

export interface ToolsSnapshot {
  config: ToolsConfig;
  probes: HostProbe[];
  jobs: JobRecord[];
  library: LibraryRecord[];
}

export function isToolHostId(value: string): value is ToolHostId {
  return value === "mac-local" || value === "pc-agent";
}
