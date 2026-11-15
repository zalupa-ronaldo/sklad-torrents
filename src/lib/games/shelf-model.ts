import type { ShelfPlatform } from "@/lib/games/platforms";

export type ShelfTransfer = "idle" | "to-ssd" | "on-ssd" | "to-hdd";
export type ShelfCompact = "not-run" | "planned" | "done" | "unavailable";

export interface ShelfGame {
  id: string;
  name: string;
  platform: ShelfPlatform;
  hddPath: string;
  ssdPath: string;
  pool: string;
  launchFile: string;
  hddIsFile: boolean;
  active: "hdd" | "ssd";
  transfer: ShelfTransfer;
  coverPath: string | null;
  year: number | null;
  developer: string | null;
  summary: string;
  steamAppId: number | null;
  sourceHash: string | null;
  copyVerified: boolean;
  sourceKept: true;
  compact: ShelfCompact;
  compactArgv: string[] | null;
  compactReason: string;
  firmwarePath: string | null;
  keysPath: string | null;
  sample: boolean;
}

export interface ShelfPlan {
  active: "hdd" | "ssd";
  transfer: ShelfTransfer;
  compact: ShelfCompact;
  compactArgv: string[] | null;
  compactReason: string;
  sourceKept: true;
  copyVerified: boolean;
  sourceHash: string | null;
  firmwarePath: string | null;
  keysPath: string | null;
}
