import { randomUUID } from "node:crypto";

import { AppError } from "@/lib/app-error";
import { chooseCompactAlgorithm } from "@/lib/windows-library/compression";
import { joinStyled, moveSteamApp, retargetAppManifest, retargetEpicManifest, steamGamePaths } from "@/lib/windows-library/launchers";
import { MemoryFs, treeHash } from "@/lib/windows-library/memory-fs";
import type { CompactDbCache } from "@/lib/compact-db/database";
import type { LibraryJob, LibraryState, WinGame } from "@/lib/windows-library/types";

const MARKER = ".sklad-winlib";

export function runningInside(root: string, processes: readonly { path: string }[]): boolean {
  const base = norm(root);
  return processes.some((process) => {
    const path = norm(process.path);
    return path === base || path.startsWith(`${base}/`);
  });
}

export function enqueueMove(state: LibraryState, input: { game: WinGame; kind: "play" | "return"; confirm: boolean; processes: readonly { path: string }[] | null }): LibraryJob {
  if (!Array.isArray(input.processes)) {
    throw new AppError(400, "Нужен список процессов. Без него игру не трогаем: она может быть запущена.");
  }
  if (input.confirm !== true) {
    throw new AppError(400, "Удаление источника и перезапись требуют confirm: true. Задание не поставлено.");
  }
  if (runningInside(input.game.root, input.processes)) {
    throw new AppError(409, "Игра запущена. Её файлы не ставятся в очередь.");
  }
  const active = state.jobs.find((job) => job.gameId === input.game.id && (job.state === "queued" || job.state === "running"));
  if (active) return active;
  const destination = destinationFor(state, input.game, input.kind);
  if (norm(destination.destRoot) === norm(input.game.root)) {
    throw new AppError(400, "Источник и назначение совпадают. Задание не поставлено.");
  }
  const job: LibraryJob = {
    id: `wjob-${randomUUID().slice(0, 8)}`,
    kind: input.kind,
    gameId: input.game.id,
    state: "queued",
    phase: "queued",
    percent: 0,
    confirm: true,
    error: null,
    sourceDeleted: false,
    verified: false,
    compactAlgorithm: null,
    phases: [],
    sourceRoot: input.game.root,
    destRoot: destination.destRoot,
    destLibrary: destination.destLibrary,
    manifestPath: input.game.manifestPath,
    libraryFoldersPath: input.game.libraryFoldersPath,
    installdir: input.game.installdir,
    steamAppId: input.game.steamAppId,
    launcher: input.game.launcher,
  };
  state.jobs.push(job);
  return job;
}

/**
 * Runs one library job against the given file map.
 * compact.exe is not started. The caller must pass MemoryFs in tests.
 */
export function advanceJob(
  state: LibraryState,
  jobId: string,
  fs: MemoryFs,
  cache: CompactDbCache | null,
  options?: { mutateCopy?: (relative: string, bytes: Buffer) => Buffer },
): LibraryJob {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) throw new AppError(404, "Задания библиотеки нет.");
  if (job.kind === "compress") {
    job.phase = "queued";
    job.phases = ["queued-compact"];
    return job;
  }
  if (job.state === "done") return job;
  const game = state.games.find((item) => item.id === job.gameId);
  if (!game) throw new AppError(404, "Игры для задания нет.");
  if (!job.confirm) {
    job.state = "needs-confirm";
    job.error = "Нет confirm: true. Источник на месте.";
    return job;
  }
  job.state = "running";
  job.phase = "copy";
  job.percent = 10;
  job.phases.push("copy");
  const sourceFiles = fs.listFiles(job.sourceRoot).filter((file) => !file.rel.endsWith(MARKER));
  if (sourceFiles.length === 0) return fail(job, "В корне игры нет файлов. Источник не удалялся.");
  if (foreignDestination(fs, job.destRoot, game.id)) {
    return fail(job, "В назначении чужие файлы. Они не перезаписываются, источник на месте.");
  }
  if (fs.exists(job.destRoot)) fs.remove(job.destRoot);
  try {
    for (const file of sourceFiles) {
      const dest = joinStyled(job.destRoot, ...file.rel.split("/"));
      const raw = fs.readBytes(file.full) ?? Buffer.alloc(0);
      fs.writeBytes(dest, options?.mutateCopy ? options.mutateCopy(file.rel, raw) : raw);
    }
    job.phase = "verify";
    job.percent = 45;
    job.phases.push("verify");
    const sourceHash = treeHash(fs, job.sourceRoot);
    const destHash = treeHash(fs, job.destRoot);
    if (sourceHash !== destHash) {
      fs.remove(job.destRoot);
      return fail(job, "Проверка копии не сошлась. Источник на месте, копия снята.");
    }
    job.verified = true;
    job.phase = "launcher";
    job.percent = 70;
    job.phases.push("launcher");
    rewriteLauncher(fs, job, game);
    fs.writeText(joinStyled(job.destRoot, MARKER), game.id);
    job.phase = "delete-source";
    job.percent = 85;
    job.phases.push("delete-source");
    if (job.launcher === "steam" && job.manifestPath && job.destLibrary && job.steamAppId) {
      const destManifest = joinStyled(job.destLibrary, "steamapps", `appmanifest_${job.steamAppId}.acf`);
      if (norm(job.manifestPath) !== norm(destManifest)) fs.remove(job.manifestPath);
    }
    fs.remove(job.sourceRoot);
    if (fs.exists(job.sourceRoot)) return fail(job, "Источник не снят целиком. Назначение уже проверено.");
    job.sourceDeleted = true;
    const choice = chooseCompactAlgorithm({ steamAppId: game.steamAppId, cache, already: game.algorithm });
    const compact = queueCompact(state, game, job.destRoot, choice.algorithm, choice.enqueue, choice.reason);
    job.compactAlgorithm = choice.algorithm;
    job.phase = "queue-compact";
    job.percent = 100;
    job.phases.push("queue-compact");
    job.state = "done";
    job.error = null;
    game.root = job.destRoot;
    game.pool = job.kind === "play" ? "playing" : "archive";
    if (job.kind === "play" && state.settings.fastSsd) {
      game.serial = state.settings.fastSsd.serial;
      game.uuid = state.settings.fastSsd.uuid;
    }
    if (job.kind === "return") {
      game.serial = game.archiveSerial;
      game.uuid = game.archiveUuid;
    }
    game.manifestPath = job.launcher === "steam" && job.steamAppId && job.destLibrary
      ? joinStyled(job.destLibrary, "steamapps", `appmanifest_${job.steamAppId}.acf`)
      : game.manifestPath;
    game.compression = compact.enqueue ? "queued" : game.compression;
    game.algorithm = choice.algorithm;
    void compact;
    return job;
  } catch (error) {
    if (!job.sourceDeleted) fs.remove(job.destRoot);
    return fail(job, error instanceof Error ? error.message : "Перенос не выполнен. Источник не подтверждён удалённым.");
  }
}

function destinationFor(state: LibraryState, game: WinGame, kind: "play" | "return"): { destRoot: string; destLibrary: string | null } {
  if (kind === "return") {
    if (game.pool !== "playing") throw new AppError(400, "Игра уже в архиве. Возврат не поставлен.");
    if (game.launcher === "steam" && game.installdir && game.steamAppId) {
      const library = parentLibrary(game.archiveRoot, game.installdir);
      return { destRoot: game.archiveRoot, destLibrary: library };
    }
    return { destRoot: game.archiveRoot, destLibrary: null };
  }
  if (game.pool === "playing") throw new AppError(400, "Игра уже в пуле «Играю сейчас».");
  const ssd = state.settings.fastSsd;
  if (!ssd?.root) throw new AppError(400, "Быстрый SSD не выбран в настройках. Путь не подставляется.");
  if (game.launcher === "steam" && game.installdir && game.steamAppId) {
    const paths = steamGamePaths(ssd.root, game.installdir, game.steamAppId);
    return { destRoot: paths.gameRoot, destLibrary: ssd.root };
  }
  const leaf = game.root.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? game.title;
  return { destRoot: joinStyled(ssd.root, leaf), destLibrary: null };
}

function rewriteLauncher(fs: MemoryFs, job: LibraryJob, game: WinGame): void {
  if (job.launcher === "steam" && job.steamAppId && job.destLibrary && job.libraryFoldersPath && job.manifestPath && job.installdir) {
    const libraryText = fs.readText(job.libraryFoldersPath);
    const manifestText = fs.readText(job.manifestPath);
    if (!libraryText || !manifestText) throw new Error("Нет libraryfolders.vdf или appmanifest. Источник не удалён.");
    const sourceLibrary = parentLibrary(job.sourceRoot, job.installdir);
    const nextLibrary = moveSteamApp(libraryText, sourceLibrary, job.destLibrary, String(job.steamAppId), game.logicalBytes ?? 0);
    const nextManifest = retargetAppManifest(manifestText, game.logicalBytes ?? 0);
    const destManifest = joinStyled(job.destLibrary, "steamapps", `appmanifest_${job.steamAppId}.acf`);
    fs.writeText(job.libraryFoldersPath, nextLibrary);
    fs.writeText(destManifest, nextManifest);
    return;
  }
  if (job.launcher === "epic" && job.manifestPath) {
    const text = fs.readText(job.manifestPath);
    if (!text) throw new Error("Нет манифеста Epic. Источник не удалён.");
    fs.writeText(job.manifestPath, retargetEpicManifest(text, job.destRoot));
  }
}

function queueCompact(state: LibraryState, game: WinGame, root: string, algorithm: string, enqueue: boolean, reason: string): { enqueue: boolean } {
  if (!enqueue) return { enqueue: false };
  const existing = state.jobs.find((job) => job.kind === "compress" && job.gameId === game.id && job.state === "queued");
  if (existing) return { enqueue: true };
  state.jobs.push({
    id: `wjob-${randomUUID().slice(0, 8)}`,
    kind: "compress",
    gameId: game.id,
    state: "queued",
    phase: "queued",
    percent: 0,
    confirm: false,
    error: null,
    sourceDeleted: false,
    verified: false,
    compactAlgorithm: algorithm,
    phases: [],
    sourceRoot: root,
    destRoot: root,
    destLibrary: null,
    manifestPath: null,
    libraryFoldersPath: null,
    installdir: null,
    steamAppId: game.steamAppId,
    launcher: game.launcher,
  });
  void reason;
  return { enqueue: true };
}

function foreignDestination(fs: MemoryFs, root: string, gameId: string): boolean {
  const files = fs.listFiles(root);
  if (files.length === 0 && !fs.readText(joinStyled(root, MARKER))) return false;
  return fs.readText(joinStyled(root, MARKER)) !== gameId;
}

function parentLibrary(gameRoot: string, installdir: string): string {
  const normalized = gameRoot.replace(/\\/g, "/");
  const marker = `/steamapps/common/${installdir}`.toLowerCase();
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index < 0) return gameRoot;
  return gameRoot.slice(0, index);
}

function fail(job: LibraryJob, message: string): LibraryJob {
  job.state = "error";
  job.phase = "error";
  job.error = message;
  job.sourceDeleted = false;
  return job;
}

function norm(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
