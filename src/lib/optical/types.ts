/** Windows-agent optical jobs. The Mac queues work; a PC agent claims hardware jobs. */

export const WINDOWS_AGENT_HOST = "pc-agent" as const;

export type OpticalKind =
  | "list-drives"
  | "media-info"
  | "burn"
  | "verify"
  | "discimagestudio-live"
  | "discimagestudio-offline";

export type OpticalHost = "pc-agent" | "windows" | "darwin" | "linux";

export type OfflineProfile = "cd" | "dvd" | "bd";

export interface OpticalDrive {
  id: string;
  name: string;
  host: string;
  letter: string;
  mediaType: string;
  capacityBytes: number | null;
  blank: boolean;
  rewritable: boolean;
}

export interface OpticalJob {
  id: string;
  kind: OpticalKind;
  host: OpticalHost | string;
  status: string;
  sourcePath: string;
  outputPath: string | null;
  driveId: string | null;
  driveName: string | null;
  mediaType: string | null;
  capacityBytes: number | null;
  eraseConfirmed: boolean;
  argv: string[];
  plan: string[];
  progress: number;
  exitCode: number | null;
  burnExited: boolean;
  verified: boolean;
  verifiedBy: string | null;
  simulation: boolean;
  error: string | null;
  log: string[];
  drives: OpticalDrive[] | null;
  createdAt: string;
  updatedAt: string;
  claimedBy: string | null;
  physicalDiscBurned: false;
}

export interface MacJobRequest {
  kind: OpticalKind;
  sourcePath?: string;
  outputPath?: string;
  driveId?: string | null;
  eraseConfirmed?: boolean;
  offlineHost?: string;
  profile?: OfflineProfile;
  host?: string;
}
