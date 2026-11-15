import type { CompactDbAlgorithm } from "@/lib/compact-db/database";
import { adviseCompression, type CompactLookup } from "@/lib/compact-db/database";
import { compactKeptBytes, nextCompactFile } from "@/lib/compact-db/batch";
import { assertEncodePaths } from "@/lib/transcode/encode-plan";
import { DEFAULT_MACHINE_LIMIT, type MachineLimit } from "@/lib/transcode/workload";

export interface CompactFile {
  path: string;
  sha256: string;
}

export interface AutoCompactPlan {
  run: boolean;
  files: string[];
  reason: string;
}

/** Eligible database row on NTFS Windows, and only then. Z: and E: never start. */
export function planAutoCompact(input: {
  os: "win32" | "darwin" | "linux";
  filesystem: string;
  root: string;
  files: readonly CompactFile[];
  lookup: CompactLookup;
  algorithm: CompactDbAlgorithm;
  alreadyAlgorithm: CompactDbAlgorithm | null;
  minSavings: number | null;
}): AutoCompactPlan {
  try {
    assertEncodePaths([input.root, ...input.files.map((file) => file.path)]);
  } catch (error) {
    return { run: false, files: [], reason: error instanceof Error ? error.message : "Путь закрыт." };
  }
  if (input.os !== "win32" || !/ntfs/i.test(input.filesystem)) {
    return { run: false, files: [], reason: "Автосжатие CompactGUI только на NTFS Windows. Файлы не менялись." };
  }
  if (input.files.length === 0) {
    return { run: false, files: [], reason: "В корне нет файлов. Сжатие не запускается." };
  }
  const advice = adviseCompression({
    lookup: input.lookup,
    requested: input.algorithm,
    alreadyAlgorithm: input.alreadyAlgorithm,
    minSavings: input.minSavings,
    manualOverride: false,
  });
  if (advice.action !== "eligible") return { run: false, files: [], reason: advice.reason };
  return { run: true, files: input.files.map((file) => file.path), reason: advice.reason };
}

/**
 * Compress one file at a time. A changed SHA-256 stops the batch.
 * Nothing is deleted. Pause waits for the next file.
 */
export async function runAutoCompact(input: {
  root: string;
  files: readonly CompactFile[];
  done?: readonly string[];
  paused?: boolean;
  userBusy?: boolean;
  running?: number;
  limit?: MachineLimit;
  compress: (file: string) => Promise<{ code: number | null }>;
  hash: (file: string) => Promise<string>;
}): Promise<{ compressed: boolean; done: string[]; stopped: boolean; attempted: boolean; reason: string; deleted: false }> {
  try {
    assertEncodePaths([input.root, ...input.files.map((file) => file.path)]);
  } catch (error) {
    return { compressed: false, done: [...(input.done ?? [])], stopped: true, attempted: false, reason: error instanceof Error ? error.message : "Путь закрыт.", deleted: false };
  }
  const done = [...(input.done ?? [])];
  const limit = { ...(input.limit ?? DEFAULT_MACHINE_LIMIT), userBusy: input.userBusy === true };
  const known = new Map(input.files.map((file) => [file.path, file.sha256]));
  let reason = "Файлы ещё не сжаты.";
  let attempted = false;
  while (true) {
    const step = nextCompactFile({
      files: input.files.map((file) => file.path),
      done,
      paused: input.paused === true,
      limit,
      running: input.running ?? 0,
    });
    if (!step.file) return { compressed: done.length === input.files.length && input.files.length > 0, done, stopped: input.paused === true || limit.userBusy, attempted, reason: step.reason, deleted: false };
    const before = known.get(step.file) ?? "";
    attempted = true;
    const outcome = await input.compress(step.file);
    if (outcome.code !== 0) {
      return { compressed: false, done, stopped: true, attempted, reason: `compact.exe завершился с кодом ${outcome.code ?? "нет"}. Файл не удалён.`, deleted: false };
    }
    const after = await input.hash(step.file);
    const kept = compactKeptBytes(before, after);
    if (!kept.ok) return { compressed: false, done, stopped: true, attempted, reason: `${kept.reason} Файл не удалён.`, deleted: false };
    done.push(step.file);
    reason = kept.reason;
  }
}
