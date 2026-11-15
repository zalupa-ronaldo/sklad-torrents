import { toIndexedFiles } from "@/addons/drives/categories";
import { normalizeRelative } from "@/addons/drives/paths";
import { describeScan } from "@/addons/drives/strategy";
import type { HostOs, IndexedFile, IndexPayload, LibraryRule, PathStyle, ScanState } from "@/addons/drives/types";

export function emptyScan(): ScanState {
  return {
    status: "idle",
    strategy: "walk",
    progress: 0,
    message: "Индекс ещё не построен.",
    elevated: false,
  };
}

export interface ApplyIndexInput {
  previous: IndexedFile[];
  previousScan: ScanState;
  update: IndexPayload | null | undefined;
  busy: boolean;
  libraries: readonly LibraryRule[];
  pathStyle: PathStyle;
  mountPath: string;
  filesystem: string;
  platform: HostOs;
  elevated: boolean;
}

function carryProgress(base: ScanState, update: IndexPayload | null | undefined, previous: ScanState): ScanState {
  const scan: ScanState = { ...base };
  const pick = <K extends keyof ScanState>(key: K, fromUpdate: ScanState[K] | undefined, fromPrevious: ScanState[K] | undefined) => {
    if (fromUpdate !== undefined) scan[key] = fromUpdate;
    else if (fromPrevious !== undefined) scan[key] = fromPrevious;
  };
  pick("processedBytes", update?.processedBytes, previous.processedBytes);
  pick("totalBytes", update?.totalBytes, previous.totalBytes);
  pick("speed", update?.speed, previous.speed);
  pick("eta", update?.eta, previous.eta);
  pick("currentFile", update?.currentFile, previous.currentFile);
  pick("priority", update?.priority, previous.priority);
  pick("pauseReason", update?.pauseReason, previous.pauseReason);
  pick("checkpoint", update?.checkpoint, previous.checkpoint);
  return scan;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function tag(files: IndexPayload["files"], input: ApplyIndexInput): IndexedFile[] {
  return toIndexedFiles(files ?? [], input.libraries, input.pathStyle, input.mountPath);
}

function applyDelta(previous: readonly IndexedFile[], update: NonNullable<IndexPayload["delta"]>, input: ApplyIndexInput): IndexedFile[] {
  const removed = new Set(update.deletes.map((path) => normalizeRelative(path)).filter(Boolean));
  const upserts = tag(update.upserts, input);
  const upserted = new Set(upserts.map((file) => file.relativePath));
  const kept = previous.filter((file) => !removed.has(file.relativePath) && !upserted.has(file.relativePath));
  return [...kept, ...upserts];
}

/**
 * Files leave the catalog only after a complete successful rescan or a complete USN delta.
 * A failed, paused, busy, or still-running update keeps the previous tree.
 */
export function applyIndexUpdate(input: ApplyIndexInput): { files: IndexedFile[]; scan: ScanState; applied: "kept" | "replaced" | "delta" } {
  const described = describeScan({
    filesystem: input.filesystem,
    platform: input.platform,
    elevated: input.elevated,
    status: input.busy ? "paused" : (input.update?.state ?? input.previousScan.status),
    busy: input.busy,
    detail: input.update?.state === "error" ? input.update.message : undefined,
  });
  const base = carryProgress({
    status: input.busy ? "paused" : (input.update?.state ?? input.previousScan.status),
    strategy: described.strategy,
    progress: input.previousScan.progress,
    message: described.message,
    elevated: input.elevated,
  }, input.update, input.previousScan);
  if (!input.update || input.busy || input.update.state === "error" || input.update.state === "paused" || input.update.state === "running" || input.update.state === "idle") {
    if (input.update && (input.update.state === "running" || input.update.state === "paused" || input.busy)) {
      base.progress = clamp(input.update.progress || input.previousScan.progress);
    }
    if (input.busy) base.pauseReason = input.update?.pauseReason ?? "busy";
    return { files: input.previous, scan: base, applied: "kept" };
  }
  if (input.update.files) {
    // A finished empty list is not a reason to forget a catalog that already has files.
    if (input.update.files.length === 0 && input.previous.length > 0 && input.update.recordCount !== 0) {
      return { files: input.previous, scan: { ...base, status: "complete", progress: 1 }, applied: "kept" };
    }
    return {
      files: tag(input.update.files, input),
      scan: { ...base, status: "complete", progress: 1 },
      applied: "replaced",
    };
  }
  if (input.update.delta?.complete) {
    return {
      files: applyDelta(input.previous, input.update.delta, input),
      scan: { ...base, status: "complete", progress: 1 },
      applied: "delta",
    };
  }
  return { files: input.previous, scan: { ...base, status: "complete", progress: input.previousScan.progress }, applied: "kept" };
}
