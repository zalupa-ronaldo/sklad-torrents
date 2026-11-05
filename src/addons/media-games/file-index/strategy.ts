import type { IndexFilesystem, IndexOs, IndexSource, IndexVolumeRequest } from "@/addons/media-games/file-index/types";

export interface StrategyInput {
  os: IndexOs;
  volume: string;
  filesystem?: IndexFilesystem;
  elevated: boolean;
  preferUsn?: boolean;
}

/**
 * Agent-side choice for one volume.
 *
 * MFT (full build) or USN (incremental journal) only when all of this is true:
 * the process is elevated, the OS is Windows, and the volume is NTFS.
 * Everything else is a normal directory walk — including a Windows volume
 * without administrator rights, a non-NTFS filesystem, macOS, APFS, and any
 * path under `/Volumes` (the Mac vault). APFS is never treated as an MFT.
 */
export function chooseIndexStrategy(input: StrategyInput): IndexSource {
  if (mustWalk(input)) return "walk";
  if (input.os === "win32" && isNtfsVolume(input) && input.elevated) {
    return input.preferUsn ? "usn" : "mft";
  }
  return "walk";
}

/** Raw `\\.\X:` / USN calls are refused for Mac paths even if a caller asks. */
export function isRawNtfsAllowed(volume: string): boolean {
  if (isMacVolumePath(volume)) return false;
  return /^[A-Za-z]:\\?$/.test(volume.trim()) || /^\\\\\.[\\/][A-Za-z]:$/.test(volume.trim());
}

export function isMacVolumePath(volume: string): boolean {
  const normalized = volume.trim().replace(/\\/g, "/");
  return /^\/+Volumes(\/|$)/.test(normalized);
}

export function explainStrategy(input: StrategyInput, source: IndexSource, fallbackDetail?: string): string {
  if (source === "mft") {
    return "Полный индекс по NTFS MFT (Master File Table). Сырой том открыт повышенным процессом.";
  }
  if (source === "usn") {
    return "Индекс обновлён по журналу USN. Полная таблица MFT заново не читалась.";
  }
  if (mustWalk(input) && (input.os === "darwin" || input.filesystem === "apfs" || isMacVolumePath(input.volume))) {
    return "APFS и пути /Volumes не используют MFT. Индекс построен обходом папок.";
  }
  if (input.os === "win32" && isNtfsVolume(input) && !input.elevated) {
    return "Индекс MFT недоступен: процесс не запущен с правами администратора. Результаты получены обходом папок.";
  }
  if (fallbackDetail) return fallbackDetail;
  return "Индекс построен обходом папок. Сырой том не открывался.";
}

export function strategyInputOf(request: IndexVolumeRequest): StrategyInput {
  return {
    os: request.os,
    volume: request.volume,
    filesystem: request.filesystem,
    elevated: request.elevated,
    preferUsn: request.preferUsn,
  };
}

function mustWalk(input: StrategyInput): boolean {
  if (input.os === "darwin") return true;
  if (input.filesystem === "apfs") return true;
  if (isMacVolumePath(input.volume)) return true;
  return false;
}

function isNtfsVolume(input: StrategyInput): boolean {
  if (mustWalk(input)) return false;
  if (input.filesystem === "ntfs") return true;
  if (input.filesystem === "unknown" || input.filesystem === "apfs") return false;
  return isRawNtfsAllowed(input.volume);
}
