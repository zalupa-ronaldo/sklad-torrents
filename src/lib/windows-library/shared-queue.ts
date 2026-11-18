import { readdir } from "node:fs/promises";

import { AppError } from "@/lib/app-error";
import { gameId, listGames, type GameRecord } from "@/lib/games/library";
import { prepareGame, registerGame, removeGame } from "@/lib/games/prepare";
import { createJobStore } from "@/lib/jobs/engine";
import type { Job } from "@/lib/jobs/model";
import { windowsVolumeLetter } from "@/lib/transcode/encode-plan";
import { runningInside } from "@/lib/windows-library/pool";
import type { LibraryState, PublicLibraryJob, WinGame } from "@/lib/windows-library/types";

/** Cold HDD path. The playing copy never replaces this root. */
export function coldRoot(game: WinGame): string {
  return game.archiveRoot || game.root;
}

export function assertLibraryPaths(paths: readonly string[]): void {
  for (const file of paths) {
    const letter = windowsVolumeLetter(file);
    if (letter === "E" || letter === "Z") throw new AppError(400, "E: и Z: не открываются.");
    if (letter === "F") throw new AppError(400, "F: — виртуальный диск Alcohol. В пул и в архив он не берётся.");
  }
}

export function assertMoveAllowed(game: WinGame, input: { confirm: boolean; processes: { path: string }[] | null }): void {
  if (!Array.isArray(input.processes)) {
    throw new AppError(400, "Нужен список процессов. Без него игру не трогаем: она может быть запущена.");
  }
  if (input.confirm !== true) throw new AppError(400, "Нужен confirm: true. Задание не поставлено.");
  const root = coldRoot(game);
  if (runningInside(root, input.processes) || runningInside(game.root, input.processes)) {
    throw new AppError(409, "Игра запущена. Её файлы не ставятся в очередь.");
  }
}

/**
 * Copy the cold root into the configured SSD pool through the shared jobs.json queue.
 * prepareGame writes one copy job. The service runs it: copy, SHA-256, then compact of that whole root.
 * The HDD directory is not removed.
 */
export async function enqueueSharedPlay(directory: string, state: LibraryState, game: WinGame): Promise<{ created: boolean; jobId: string; engineId: string }> {
  const pool = state.settings.fastSsd?.root;
  if (!pool) throw new AppError(400, "Быстрый SSD не выбран в настройках. Путь не подставляется.");
  const root = coldRoot(game);
  assertLibraryPaths([root, pool]);
  const exe = await exeInRoot(root);
  const registered = await registerGame({
    directory,
    root,
    pool,
    name: game.title,
    exe: exe ?? undefined,
    steamAppId: game.steamAppId,
  });
  if (registered.ok !== true) throw new AppError(400, String(registered.error ?? "Игра не записана в общую библиотеку."));
  const engineId = String((registered.game as { id: string }).id);
  const prepared = await prepareGame(engineId, process.env.SKLAD_COMPACT_DB || null, directory);
  if (prepared.ok !== true) throw new AppError(400, String(prepared.error ?? "Подготовка не поставлена."));
  state.pins[game.id] = engineId;
  return { created: prepared.created === true, jobId: String(prepared.jobId ?? ""), engineId };
}

/** Explicit removal of the pool copy. Refuses unless the cold copy still matches the verified manifest. */
export async function removeSharedCopy(directory: string, state: LibraryState, game: WinGame): Promise<{ sourceKept: boolean }> {
  const root = coldRoot(game);
  const id = state.pins[game.id] || gameId(root, game.steamAppId, game.title);
  const record = (await listGames(directory)).find((item) => item.id === id);
  assertLibraryPaths([root, record?.pool, record?.destination].filter((item): item is string => Boolean(item)));
  const removed = await removeGame(id, directory);
  if (removed.ok !== true) throw new AppError(400, String(removed.error ?? "Копия с пула не снята."));
  if (removed.sourceKept !== true) throw new AppError(500, "Холодная копия должна остаться на месте.");
  return { sourceKept: true };
}

export async function sharedGameJobs(directory: string): Promise<Job[]> {
  const list = await createJobStore(directory).list({ limit: 200 });
  return list.jobs.filter((job) => job.payload.diskId.startsWith("game:"));
}

export async function engineRecords(directory: string): Promise<GameRecord[]> {
  return listGames(directory);
}

export function sharedJobView(job: Job, winId: string): PublicLibraryJob {
  const state = job.state === "paused" || job.state === "running" ? "running" : job.state === "done" ? "done" : job.state === "error" ? "error" : "queued";
  return {
    id: job.id,
    kind: "play",
    gameId: winId,
    state,
    phase: job.verified ? "verified" : job.state,
    percent: job.state === "done" ? 100 : job.progress.percent,
    error: job.lastError,
    sourceDeleted: false,
    verified: job.verified,
    compactAlgorithm: job.payload.compactAlgorithm || null,
  };
}

export function recordFor(records: readonly GameRecord[], state: LibraryState, game: WinGame): GameRecord | undefined {
  const pinned = state.pins[game.id];
  if (pinned) return records.find((item) => item.id === pinned);
  return records.find((item) => item.id === gameId(coldRoot(game), game.steamAppId, game.title));
}

async function exeInRoot(root: string): Promise<string | null> {
  try {
    const names = await readdir(root);
    return names.find((name) => name.toLowerCase().endsWith(".exe") || name === "play.mjs") ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
