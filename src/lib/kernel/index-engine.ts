import { isVaultPath } from "@/lib/kernel/volume";
import type { CatalogFile, Filesystem, IndexMethod } from "@/lib/kernel/types";

export interface IndexSnapshot {
  files: CatalogFile[];
  complete: boolean;
}

export interface IndexRequest {
  filesystem: Filesystem;
  mountPoint: string;
  elevated: boolean;
  previous: IndexSnapshot | null;
  heavyActivity: boolean;
  readMft?: () => CatalogFile[];
  readUsn?: (previous: CatalogFile[]) => CatalogFile[];
  walk?: () => CatalogFile[];
}

export interface IndexOutcome {
  committed: boolean;
  paused: boolean;
  method: IndexMethod | null;
  files: CatalogFile[] | null;
  error: string | null;
  message: string;
}

export function mftAllowed(filesystem: Filesystem, mountPoint: string): boolean {
  return filesystem === "ntfs" && !isVaultPath(mountPoint);
}

/**
 * Read-only index plan. A failed or paused scan returns files: null.
 * The caller must keep the previous list, so an error cannot mark files deleted.
 * A successful outcome may replace the list, including with an empty one.
 */
export function planIndex(request: IndexRequest): IndexOutcome {
  if (request.heavyActivity) {
    return {
      committed: false,
      paused: true,
      method: null,
      files: null,
      error: null,
      message: "Индексация на паузе: на диске идёт активная работа. Прежний список сохранён, файлы не помечаются удалёнными.",
    };
  }

  const allowMft = mftAllowed(request.filesystem, request.mountPoint);
  try {
    if (allowMft && request.elevated && request.previous?.complete && request.readUsn) {
      return {
        committed: true,
        paused: false,
        method: "usn",
        files: request.readUsn(request.previous.files),
        error: null,
        message: "Инкремент по журналу USN (NTFS). Демо-адаптер не открывает том.",
      };
    }
    if (allowMft && request.elevated && request.readMft) {
      return {
        committed: true,
        paused: false,
        method: "mft",
        files: request.readMft(),
        error: null,
        message: "Полное чтение MFT (Master File Table). В облаке это демо-адаптер, сырой том не открывался.",
      };
    }
    if (!request.walk) {
      throw new Error("Нет способа прочитать каталог.");
    }
    const files = request.walk();
    const message = allowMft
      ? "Нет прав администратора на том NTFS — обычный обход файлов, без MFT и USN."
      : "Только обход каталогов. MFT не запускается на APFS, HFS, exFAT и /Volumes/vault.";
    return {
      committed: true,
      paused: false,
      method: "walk",
      files,
      error: null,
      message,
    };
  } catch (error) {
    return {
      committed: false,
      paused: false,
      method: null,
      files: null,
      error: error instanceof Error ? error.message : "Ошибка индексации",
      message: "Ошибка чтения. Прежний индекс сохранён, файлы не помечены удалёнными.",
    };
  }
}

export function applyIndexResult(previous: CatalogFile[], outcome: IndexOutcome): CatalogFile[] {
  if (!outcome.committed || outcome.files === null) return previous;
  return outcome.files;
}
