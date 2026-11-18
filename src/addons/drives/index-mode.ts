import type { HostOs, IndexDelta, RawIndexedFile } from "@/addons/drives/types";

export type IndexMode = "mft" | "usn" | "fsevents" | "walk" | "none";
export type IndexReason = "attach" | "change" | "restart";

export interface IndexModeInput {
  filesystem: string;
  platform: HostOs | "linux";
  hasCatalog: boolean;
  usnCursor: string | null;
  lastEventId: string | null;
  journalLost: boolean;
  reason: IndexReason;
}

function kindOf(filesystem: string): "ntfs" | "apfs" | "hfs" | "none" {
  const fs = filesystem.trim().toLowerCase();
  if (fs.includes("ntfs")) return "ntfs";
  if (fs.includes("apfs")) return "apfs";
  if (fs.includes("hfs")) return "hfs";
  return "none";
}

/**
 * What to read after an attach, a journal event, or a process start.
 * A timer is not a reason. A finished catalog is not read again unless the
 * journal moved or was lost. exFAT and FAT have no journal: one walk on attach.
 */
export function indexMode(input: IndexModeInput): IndexMode {
  const kind = kindOf(input.filesystem);
  if (kind === "ntfs" && input.platform === "win32") {
    if (input.journalLost || !input.hasCatalog) return "mft";
    if (input.usnCursor && (input.reason === "change" || input.reason === "restart")) return "usn";
    return "none";
  }
  if ((kind === "apfs" || kind === "hfs") && input.platform === "darwin") {
    if (input.journalLost || !input.hasCatalog) return "walk";
    if (input.reason === "change") return "fsevents";
    if (input.lastEventId && input.reason === "restart") return "fsevents";
    return "none";
  }
  if (!input.hasCatalog && input.reason !== "change") return "walk";
  return "none";
}

export function applyRawDelta(previous: readonly RawIndexedFile[], delta: IndexDelta): RawIndexedFile[] {
  const removed = new Set(delta.deletes);
  const next = new Map(previous.map((file) => [file.relativePath, file]));
  for (const path of removed) next.delete(path);
  for (const file of delta.upserts) next.set(file.relativePath, file);
  return [...next.values()];
}

export interface VolumeWatchEvent {
  type: "attach" | "detach" | "journal" | "journal-lost" | "cursor";
  serial?: string;
  volumeUuid?: string;
  letter?: string | null;
  mount?: string;
  cursor?: string | null;
  delta?: IndexDelta | null;
}

export interface VolumeWatch {
  start(onEvent: (event: VolumeWatchEvent) => void): void;
  stop(): void;
}
