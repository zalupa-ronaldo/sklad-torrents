import type { MacJobRequest, OpticalDrive, OpticalHost, OpticalJob, OpticalKind } from "../../src/lib/optical/types";

export const WINDOWS_AGENT_HOST: "pc-agent";
export const MOCK_DRIVE_NAME: string;
export const MOCK_DRIVES: OpticalDrive[];

export function isWindowsWorker(host: string): boolean;
export function isHardwareKind(kind: OpticalKind): boolean;
export function isRewritable(mediaType: string | null | undefined): boolean;
export function containsLocalMacBurn(argv: readonly string[], plan: readonly string[]): boolean;
export function assertNoLocalMacBurn(argv: readonly string[], plan: readonly string[]): void;

export function buildHardwarePlan(input: {
  kind: Exclude<OpticalKind, "discimagestudio-offline">;
  sourcePath?: string;
  driveId?: string | null;
  eraseConfirmed?: boolean;
}): { argv: string[]; plan: string[] };

export function buildOfflineImagePlan(input: {
  sourcePath?: string;
  outputPath?: string;
  profile?: MacJobRequest["profile"];
}): { argv: string[]; plan: string[] };

export function claimAndExecute(
  job: OpticalJob,
  options?: {
    workerHost?: OpticalHost | string;
    mock?: boolean;
    drives?: OpticalDrive[];
    priorJobs?: OpticalJob[];
  },
): OpticalJob;

export function mergeAgentReport(local: OpticalJob, remote: Partial<OpticalJob> | null | undefined): OpticalJob;
