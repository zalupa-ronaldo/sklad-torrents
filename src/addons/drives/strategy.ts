import { chooseIndexStrategy } from "@/addons/media-games/file-index/strategy";
import type { HostOs, IndexStrategy, ScanStatus } from "@/addons/drives/types";

export interface StrategyInput {
  filesystem: string;
  platform: HostOs | "linux";
  elevated: boolean;
}

export interface StrategyDecision {
  strategy: IndexStrategy;
  /** True only for elevated Windows NTFS. APFS, HFS, and exFAT never qualify. */
  usesMft: boolean;
}

function normalizedFs(filesystem: string): string {
  return filesystem.trim().toLowerCase().replace(/[^a-z0-9+]/g, "");
}

export function isNtfs(filesystem: string): boolean {
  return normalizedFs(filesystem) === "ntfs";
}

export function isApfs(filesystem: string): boolean {
  return normalizedFs(filesystem).includes("apfs");
}

export function selectIndexStrategy(input: StrategyInput): StrategyDecision {
  const fs = normalizedFs(input.filesystem);
  const filesystem = fs === "ntfs" ? "ntfs" : fs.includes("apfs") ? "apfs" : "unknown";
  const os = input.platform === "win32" ? "win32" : input.platform === "darwin" ? "darwin" : "linux";
  const source = chooseIndexStrategy({
    os,
    volume: os === "win32" ? "D:\\" : "/Volumes/vault",
    filesystem,
    elevated: input.elevated,
    preferUsn: true,
  });
  if (source === "mft" || source === "usn") return { strategy: "mft-usn", usesMft: true };
  return { strategy: "walk", usesMft: false };
}

export function describeScan(input: StrategyInput & { status: ScanStatus; busy: boolean; detail?: string }): {
  strategy: IndexStrategy;
  message: string;
} {
  const decision = selectIndexStrategy(input);
  if (input.busy || input.status === "paused") {
    return {
      strategy: decision.strategy,
      message: "Диск занят, индексация на паузе. Уже найденные файлы остаются в каталоге.",
    };
  }
  if (input.status === "error") {
    const detail = input.detail?.trim();
    return {
      strategy: decision.strategy,
      message: detail
        ? `Индексация прервалась. Прежний каталог не изменён. ${detail}`
        : "Индексация прервалась. Прежний каталог не изменён.",
    };
  }
  if (input.status === "idle") {
    return { strategy: decision.strategy, message: "Индекс ещё не построен." };
  }
  const done = input.status === "complete";
  if (decision.strategy === "mft-usn") {
    return {
      strategy: "mft-usn",
      message: done ? "Индекс по MFT и журналу USN готов." : "Чтение MFT и журнала USN.",
    };
  }
  const fs = normalizedFs(input.filesystem);
  if (fs === "ntfs" && input.platform === "win32" && !input.elevated) {
    return {
      strategy: "walk",
      message: done
        ? "Индекс готов обходом папок: нет прав администратора, MFT и USN не использовались."
        : "Обход папок: нет прав администратора, MFT и USN недоступны. Готовый индекс не стирается.",
    };
  }
  if (fs.includes("apfs")) {
    return {
      strategy: "walk",
      message: done
        ? "Индекс APFS готов. Обход папок, MFT не используется."
        : "Обход APFS. MFT не используется.",
    };
  }
  if (fs.includes("hfs")) {
    return {
      strategy: "walk",
      message: done ? "Индекс HFS готов. Обход папок, MFT не используется." : "Обход HFS. MFT не используется.",
    };
  }
  if (fs.includes("exfat")) {
    return {
      strategy: "walk",
      message: done
        ? "Индекс exFAT готов. Обход папок, MFT не используется."
        : "Обход exFAT. MFT не используется.",
    };
  }
  return {
    strategy: "walk",
    message: done ? "Индекс готов. Обход папок, MFT не используется." : "Обход файловой системы. MFT не используется.",
  };
}
