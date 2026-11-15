import { spawn } from "node:child_process";

import { buildCompactArgv, DEFAULT_COMPACT_EXE } from "@/addons/media-games/compact";
import { systemCompactReason } from "@/addons/drives/compact-target";
import type { CompactAlgorithm } from "@/addons/media-games/types";
import { listOwnedFiles, measureWindowsRoot } from "@/lib/games/compact-measure";
import { assertEncodePaths } from "@/lib/transcode/encode-plan";

export interface CompactMetrics {
  allocated: number | null;
  wof: number | null;
  logical?: number | null;
  files?: number;
}

export interface CompactRun {
  /** A process was started. Linux never sets this. */
  executed: boolean;
  /** True only after a Windows NTFS run with measured allocated or WOF bytes. */
  compressed: boolean;
  /** True only when this Windows process measured a smaller owned root. */
  ntfsSmoke: boolean;
  logical: number | null;
  /** Exit 0 and known metrics would allow ready. Still not a physical smoke result. */
  contractReady: boolean;
  reason: string;
  argv: string[] | null;
  allocated: number | null;
  wof: number | null;
  exitCode: number | null;
}

export interface CompactSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

export async function executeCompact(input: {
  os: NodeJS.Platform;
  filesystem: string;
  role: "game-pool" | "cold-archive" | "scratch" | "forbidden" | "virtual" | "other";
  root: string;
  escapes: readonly string[];
  algorithm: CompactAlgorithm;
  binary?: string;
  spawnImpl?: (bin: string, args: string[], cwd: string) => Promise<CompactSpawnResult>;
  measure?: () => Promise<CompactMetrics>;
  stop?: () => boolean;
  timeoutMs?: number;
}): Promise<CompactRun> {
  const none = (reason: string, argv: string[] | null = null): CompactRun => ({
    executed: false,
    compressed: false,
    ntfsSmoke: false,
    contractReady: false,
    reason,
    argv,
    logical: null,
    allocated: null,
    wof: null,
    exitCode: null,
  });
  try {
    assertEncodePaths([input.root]);
  } catch (error) {
    return none(error instanceof Error ? error.message : "Путь закрыт.");
  }
  if (input.escapes.length > 0) return none("В корне есть выход наружу. compact.exe не запускается.");
  if (input.os !== "win32" || !/ntfs/i.test(input.filesystem)) {
    return none("compact.exe только на NTFS Windows. Здесь он не запускался и сжатие не засчитано.");
  }
  if (input.role !== "game-pool" && input.role !== "cold-archive") return none("Этот том не пул и не холодный архив. Сжатие не запускается.");
  const native = process.platform === "win32" && input.os === "win32" && !input.measure && !input.spawnImpl;
  if (native) {
    const owned = await listOwnedFiles(input.root);
    if (!owned.ok) return none(owned.reason);
    if (owned.files.length === 0) return none("В корне нет файлов. Сжатие не запускается.");
  }
  const banned = systemCompactReason(input.root);
  if (banned) return none(banned);
  let argv: string[];
  try {
    argv = buildCompactArgv({
      os: "win32",
      binary: input.binary || DEFAULT_COMPACT_EXE,
      folder: input.root,
      algorithm: input.algorithm,
    });
  } catch (error) {
    return none(error instanceof Error ? error.message : "Аргументы compact.exe не собраны.");
  }
  const run = input.spawnImpl ?? spawnCompact;
  let outcome: CompactSpawnResult;
  try {
    outcome = await run(argv[0]!, argv.slice(1), input.root);
  } catch (error) {
    return { ...none(error instanceof Error ? error.message : "compact.exe не запустился.", argv), argv };
  }
  if (outcome.cancelled) return { ...none("Сжатие отменено. Папка не помечена сжатой.", argv), executed: true, argv, exitCode: outcome.code };
  if (outcome.timedOut) return { ...none("Сжатие превысило время. Папка не помечена сжатой.", argv), executed: true, argv, exitCode: outcome.code };
  if (outcome.code !== 0) return { ...none(`compact.exe завершился с кодом ${outcome.code ?? "нет"}. Это не сжатие.`, argv), executed: true, argv, exitCode: outcome.code };
  if (native) {
    const measured = await measureWindowsRoot(input.root);
    return {
      executed: true,
      compressed: measured.compressed,
      ntfsSmoke: measured.compressed,
      contractReady: measured.compressed,
      reason: measured.reason,
      argv,
      logical: measured.logical,
      allocated: measured.allocated,
      wof: measured.wof,
      exitCode: 0,
    };
  }
  const metrics = input.measure ? await input.measure() : { allocated: null, wof: null, logical: null };
  const known = metrics.allocated != null && metrics.wof != null;
  if (!known) {
    return {
      executed: true,
      compressed: false,
      ntfsSmoke: false,
      contractReady: false,
      reason: "После compact.exe allocated и WOF неизвестны. Неизвестный размер не записывается как 0, и сжатие не засчитано.",
      argv,
      logical: metrics.logical ?? null,
      allocated: null,
      wof: null,
      exitCode: 0,
    };
  }
  return {
    executed: true,
    compressed: false,
    ntfsSmoke: false,
    contractReady: true,
    reason: "Контракт процесса выполнен на подставных метриках. Физический NTFS не проверялся, сжатие диска не засчитано.",
    argv,
    logical: metrics.logical ?? null,
    allocated: metrics.allocated,
    wof: metrics.wof,
    exitCode: 0,
  };
}

/** Ready only when compact.exe itself reported a measured result. A stand-in process does not. */
export function compactAllowsLaunch(result: CompactRun): boolean {
  return result.compressed === true && result.exitCode === 0 && result.allocated != null && result.wof != null && (result.logical == null || result.allocated < result.logical);
}

function spawnCompact(bin: string, args: string[], cwd: string): Promise<CompactSpawnResult> {
  return new Promise((resolve) => {
  const child = spawn(bin, args, { shell: false, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (value: CompactSpawnResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({ code: null, stdout, stderr, timedOut: true });
  }, 120_000);
  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdout.length < 64_000) stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 64_000) stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => finish({ code: null, stdout, stderr: error.message }));
  child.on("close", (code) => finish({ code, stdout, stderr }));
});
}
