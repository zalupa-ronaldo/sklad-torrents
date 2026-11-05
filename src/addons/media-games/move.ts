import { ToolsError } from "@/addons/media-games/errors";
import { assertToolPath, isNestedPath, pathLeaf, sameToolPath } from "@/addons/media-games/paths";
import type { LibraryRecord, ToolHostId, ToolOs, VerifyResult } from "@/addons/media-games/types";

export interface CopyReceipt {
  files: number;
  bytes: number;
  marker: string;
}

export interface FolderMoveAdapter {
  copy(source: string, destination: string): Promise<CopyReceipt>;
  verify(source: string, destination: string, receipt: CopyReceipt): Promise<VerifyResult>;
  deleteSource(source: string): Promise<void>;
}

export type MovePhase = "planned" | "copied" | "verified" | "verify-failed" | "delete-confirmed" | "kept";

export interface MovePlan {
  name: string;
  hostId: ToolHostId;
  os: ToolOs;
  sourcePath: string;
  destinationPath: string;
  phase: MovePhase;
  verified: boolean;
  deleteSource: boolean;
  sourceDeleted: boolean;
  receipt: CopyReceipt | null;
  verify: VerifyResult | null;
}

export function planMove(input: {
  hostId: ToolHostId;
  os: ToolOs;
  name: string;
  sourcePath: string;
  destinationPath: string;
}): MovePlan {
  const name = input.name.trim() || pathLeaf(input.os, input.sourcePath);
  if (!name) throw new ToolsError("validation", "Укажите название.");
  const sourcePath = assertToolPath(input.os, input.sourcePath, "исходную папку");
  const destinationPath = assertToolPath(input.os, input.destinationPath, "папку назначения");
  if (sameToolPath(input.os, sourcePath, destinationPath)) {
    throw new ToolsError("validation", "Папка назначения должна отличаться от исходной.");
  }
  if (isNestedPath(input.os, sourcePath, destinationPath) || isNestedPath(input.os, destinationPath, sourcePath)) {
    throw new ToolsError("validation", "Нельзя копировать папку внутрь самой себя.");
  }
  return {
    name: name.slice(0, 120),
    hostId: input.hostId,
    os: input.os,
    sourcePath,
    destinationPath,
    phase: "planned",
    verified: false,
    deleteSource: false,
    sourceDeleted: false,
    receipt: null,
    verify: null,
  };
}

export function applyCopy(plan: MovePlan, receipt: CopyReceipt): MovePlan {
  if (plan.phase !== "planned") {
    throw new ToolsError("validation", "Копирование уже запускалось.");
  }
  return {
    ...plan,
    phase: "copied",
    receipt,
    verified: false,
    deleteSource: false,
    sourceDeleted: false,
  };
}

export function applyVerify(plan: MovePlan, result: VerifyResult): MovePlan {
  if (plan.phase !== "copied" || !plan.receipt) {
    throw new ToolsError("validation", "Сначала копирование, потом проверка.");
  }
  if (!result.ok || result.sourceHash !== result.destHash || result.sourceFiles !== result.destFiles || result.sourceBytes !== result.destBytes) {
    return {
      ...plan,
      phase: "verify-failed",
      verified: false,
      deleteSource: false,
      sourceDeleted: false,
      verify: { ...result, ok: false },
    };
  }
  return {
    ...plan,
    phase: "verified",
    verified: true,
    deleteSource: false,
    sourceDeleted: false,
    verify: result,
  };
}

/** Delete stays off unless the copy is verified and the user explicitly confirms. */
export function confirmSourceDelete(plan: MovePlan, userConfirmed: boolean): MovePlan {
  if (!plan.verified || plan.phase !== "verified" || !userConfirmed) {
    return {
      ...plan,
      phase: plan.verified && !userConfirmed ? "kept" : plan.phase,
      deleteSource: false,
      sourceDeleted: false,
    };
  }
  return {
    ...plan,
    phase: "delete-confirmed",
    deleteSource: true,
    sourceDeleted: false,
  };
}

export function markSourceDeleted(plan: MovePlan): MovePlan {
  if (!plan.verified || !plan.deleteSource || plan.phase !== "delete-confirmed") {
    throw new ToolsError("validation", "Источник не удаляется, пока копия не проверена и удаление не подтверждено.");
  }
  return { ...plan, sourceDeleted: true };
}

export function libraryFromPlan(plan: MovePlan, jobId: string, now: number): LibraryRecord {
  if (!plan.verified || plan.phase === "planned" || plan.phase === "copied" || plan.phase === "verify-failed") {
    throw new ToolsError("validation", "Запись библиотеки обновляется только после успешной проверки.");
  }
  return {
    id: `lib-${jobId}`,
    name: plan.name,
    hostId: plan.hostId,
    oldPath: plan.sourcePath,
    newPath: plan.destinationPath,
    status: plan.sourceDeleted ? "moved" : "verified",
    jobId,
    updatedAt: now,
  };
}

export function manifestHash(files: number, bytes: number): string {
  const text = `files=${files};bytes=${bytes}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildVerifyResult(stats: { files: number; bytes: number }, ok = true): VerifyResult {
  const hash = manifestHash(stats.files, stats.bytes);
  if (!ok) {
    const destFiles = Math.max(0, stats.files - 1);
    const destBytes = Math.max(0, stats.bytes - 4096);
    return {
      ok: false,
      sourceFiles: stats.files,
      destFiles,
      sourceBytes: stats.bytes,
      destBytes,
      sourceHash: hash,
      destHash: manifestHash(destFiles, destBytes),
      message: "Проверка не сошлась. Исходная папка не удаляется.",
    };
  }
  return {
    ok: true,
    sourceFiles: stats.files,
    destFiles: stats.files,
    sourceBytes: stats.bytes,
    destBytes: stats.bytes,
    sourceHash: hash,
    destHash: hash,
    message: "Совпали число файлов, объём и хеш списка файлов.",
  };
}

export function assertDeletableFolder(os: ToolOs, folder: string): string {
  const normalized = assertToolPath(os, folder, "исходную папку");
  const sep = os === "win32" ? "\\" : "/";
  const parts = normalized.split(sep).filter(Boolean);
  if (os === "darwin" && parts.length < 3) {
    throw new ToolsError("validation", "Слишком короткий путь, исходную папку нельзя удалить.");
  }
  if (os === "win32" && parts.length < 2) {
    throw new ToolsError("validation", "Нельзя удалить корень диска.");
  }
  return normalized;
}
