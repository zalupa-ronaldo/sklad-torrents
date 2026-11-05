import { ToolsError } from "@/addons/media-games/errors";
import { normalizeToolPath } from "@/addons/media-games/paths";
import { isCompactAlgorithm } from "@/addons/media-games/presets";
import type { CompactAlgorithm, ToolOs } from "@/addons/media-games/types";

export const DEFAULT_COMPACT_EXE = "C:\\Windows\\System32\\compact.exe";

export const COMPACT_GUI_NOTE =
  "CompactGUI — графическая оболочка для Windows. Склад вызывает системный compact.exe (compact /C /EXE:…). Это только NTFS. На Mac и на /Volumes/vault (APFS) сжатие недоступно.";

const MOCK_BEFORE = 40_000_000_000;
const MOCK_RATIO: Record<CompactAlgorithm, number> = {
  LZX: 58,
  XPRESS16K: 68,
  XPRESS8K: 75,
  XPRESS4K: 84,
};

export function isApfsPath(folder: string): boolean {
  const value = folder.trim().replace(/\\/g, "/");
  if (value.startsWith("//")) return false;
  return value.startsWith("/");
}

export function isNtfsPath(folder: string): boolean {
  return /^[A-Za-z]:\\/.test(folder) || folder.startsWith("\\\\");
}

export function assertNtfsFolder(folder: string): string {
  const raw = folder.trim();
  if (!raw) throw new ToolsError("validation", "Укажите папку для сжатия.");
  if (isApfsPath(raw) || /^[/\\]+volumes([/\\]|$)/i.test(raw)) {
    throw new ToolsError("unavailable", "Только Windows, NTFS. Нельзя сжимать APFS, в том числе /Volumes/vault.");
  }
  const normalized = normalizeToolPath("win32", raw);
  if (!isNtfsPath(normalized)) {
    throw new ToolsError(
      "unavailable",
      "Только Windows, NTFS. Нужен путь с буквой диска (D:\\Games) или UNC (\\\\server\\share).",
    );
  }
  return normalized;
}

/** Argv for compact.exe. Refuses macOS hosts and APFS paths before any process starts. */
export function buildCompactArgv(input: {
  os: ToolOs;
  binary: string;
  folder: string;
  algorithm: CompactAlgorithm;
}): string[] {
  if (input.os !== "win32") {
    throw new ToolsError("unavailable", "Только Windows, NTFS.");
  }
  if (!isCompactAlgorithm(input.algorithm)) {
    throw new ToolsError("validation", "Неизвестный алгоритм сжатия.");
  }
  const folder = assertNtfsFolder(input.folder);
  const binary = input.binary.trim() || DEFAULT_COMPACT_EXE;
  return [binary, "/C", `/EXE:${input.algorithm}`, `/S:${folder}`];
}

export function compressAvailability(
  os: ToolOs,
  folder: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (os !== "win32") return { ok: false, reason: "Только Windows, NTFS." };
  if (!folder.trim()) return { ok: false, reason: "Укажите папку на диске Windows." };
  try {
    return { ok: true, path: assertNtfsFolder(folder) };
  } catch (error) {
    const reason = error instanceof ToolsError ? error.message : "Путь не подходит для NTFS.";
    return { ok: false, reason };
  }
}

export function estimateCompactSavings(
  algorithm: CompactAlgorithm,
  bytesBefore = MOCK_BEFORE,
): { bytesBefore: number; bytesAfter: number } {
  const ratio = MOCK_RATIO[algorithm];
  return { bytesBefore, bytesAfter: Math.round((bytesBefore * ratio) / 100) };
}
