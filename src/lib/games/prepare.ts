import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { buildCompactArgv } from "@/addons/media-games/compact";
import { compactAllowsLaunch, executeCompact } from "@/lib/games/compact-run";
import { adviseCompression, cacheFromText, lookupCompactResult } from "@/lib/compact-db/database";
import { createJobStore } from "@/lib/jobs/engine";
import { localJobHost } from "@/lib/jobs/local-host";
import type { Job } from "@/lib/jobs/model";
import { evictPreparedGame, gamePoolSpace, removeFromGamePool } from "@/lib/policies/storage-roles";
import { dataDir } from "@/lib/qbittorrent/store";
import {
  GAME_LIMITS,
  assessRegistration,
  assertGamePaths,
  directoryExists,
  gameId,
  hashFile,
  listGames,
  publicGame,
  removeTree,
  samePlace,
  saveGames,
  type GameFile,
  type GameRecord,
} from "@/lib/games/library";

const MIN_SAVINGS = 0.1;

export async function registerGame(input: {
  root: string;
  pool: string;
  name?: string;
  exe?: string;
  steamAppId?: number | null;
  offline?: boolean;
  directory?: string;
}): Promise<Record<string, unknown>> {
  const directory = input.directory ?? dataDir();
  assertGamePaths([input.root, input.pool]);
  if (samePlace(input.root, input.pool)) return blocked("Источник и пул совпадают или вложены.");
  const explicit = input.name && input.exe && input.steamAppId ? { name: input.name, steamAppId: input.steamAppId, exe: input.exe } : null;
  if (input.offline) {
    if (!explicit) return blocked("Офлайн-игру можно записать только явными именем и exe. Диск не опрашивается.");
    return saveRegistered(directory, input.root, input.pool, explicitIdentity(explicit), false);
  }
  const exists = await directoryExists(input.root);
  if (!exists) {
    if (!explicit) return blocked("Корня нет на месте. Без явной регистрации офлайн-запись не создаётся и том не ищется.");
    return saveRegistered(directory, input.root, input.pool, explicitIdentity(explicit), false);
  }
  const manifest = await readManifest(input.root);
  const exe = manifest?.exe || input.exe || "";
  const exeInside = exe ? await fileInside(input.root, exe) : false;
  const assessed = assessRegistration({ manifest, explicit, exeInside });
  if (!assessed.ok) return blocked(assessed.reason);
  return saveRegistered(directory, input.root, input.pool, assessed, true);
}

export async function prepareGame(id: string, compactDb: string | null, directory = dataDir()): Promise<Record<string, unknown>> {
  const games = await listGames(directory);
  const game = games.find((item) => item.id === id);
  if (!game) return blocked("Игры в библиотеке нет.");
  if (!game.online) return blocked("Источник offline. Подготовка не начинает живой опрос диска.", game);
  if (!game.pool) return blocked("Пул не задан. Задание не ставится.", game);
  if (!(await directoryExists(game.pool))) return blocked("Каталога пула нет. Задание не ставится.", game);
  assertGamePaths([game.root, game.pool, game.destination]);
  if (samePlace(game.root, game.destination)) return blocked("Источник и назначение совпадают или вложены.", game);
  const eviction = evictPreparedGame("space-pressure");
  if (eviction.evict) return blocked("Автовытеснение запрещено.", game);
  if (!(await directoryExists(game.root))) {
    game.online = false;
    game.state = "blocked";
    game.ready = false;
    game.reason = "Источник исчез. Подготовка остановлена.";
    await saveGames(games, directory);
    return blocked(game.reason, game);
  }
  const stranger = await unmanagedDestination(game);
  if (stranger) return blocked(stranger, game);
  const files = await collectFiles(game.root);
  if (!files.ok) return blocked(files.reason, game);
  const free = await freeBytes(game.pool);
  const space = gamePoolSpace({ freeBytes: free, neededBytes: files.bytes * 2 });
  if (!space.ok) {
    game.state = "blocked";
    game.ready = false;
    game.reason = "В тестовом пуле мало места. Жертва не выбирается, игра из пула не снимается.";
    await saveGames(games, directory);
    return { ok: false, state: "blocked", ready: false, victim: space.victim, error: game.reason, game: publicGame(game) };
  }
  const host = localJobHost();
  if (!host) return blocked("Платформа процесса не Mac, Windows и не Linux. Метка linux не подставляется.", game);
  const store = createJobStore(directory);
  const queued = await store.enqueue(
    { kind: "copy", host, source: game.root, destination: game.destination, diskId: `game:${game.id}` },
    { anyState: true },
  );
  if (queued.job.state === "done" && game.copyVerified && (await directoryExists(game.destination))) {
    return { ok: true, state: game.ready ? "available" : "blocked", created: false, ready: game.ready, jobId: queued.job.id, game: publicGame(game) };
  }
  if ((queued.job.state === "done" || queued.job.state === "error") && !(await directoryExists(game.destination))) {
    await store.requeueCopy(queued.job.id);
  }
  game.compactDbPath = compactDb;
  game.jobId = queued.job.id;
  game.state = "preparing";
  game.reason = "";
  await saveGames(games, directory);
  return { ok: true, state: "queued", created: queued.created, jobId: queued.job.id, ready: false, game: publicGame(game), compactDb: compactDb ?? null };
}

export async function runGameOnce(directory = dataDir(), compactDb: string | null = process.env.SKLAD_COMPACT_DB || null): Promise<Record<string, unknown>> {
  const host = localJobHost();
  if (!host) return { processed: false, state: "idle", error: "Платформа процесса не Mac, Windows и не Linux." };
  const store = createJobStore(directory);
  await store.requeueStale(host, (job) => job.kind === "copy" && job.payload.diskId.startsWith("game:") && stale(directory, job));
  const job = await store.claimNext(host, (item) => item.kind === "copy" && item.payload.diskId.startsWith("game:"));
  if (!job?.workerToken) return { processed: false, state: "idle" };
  await writeLease(directory, job.id);
  try {
    return await execute(store, directory, job, job.workerToken, compactDb);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Подготовка не выполнилась.";
    await store.fail(job.id, job.workerToken, message).catch(() => undefined);
    await mark(directory, job.payload.diskId.slice(5), (game) => {
      game.state = "blocked";
      game.ready = false;
      game.copyVerified = false;
      game.reason = message;
    });
    return { processed: true, state: "error", verified: false, ready: false, error: message };
  }
}

async function execute(store: ReturnType<typeof createJobStore>, directory: string, job: Job, token: string, compactDb: string | null): Promise<Record<string, unknown>> {
  const id = job.payload.diskId.slice(5);
  const games = await listGames(directory);
  const game = games.find((item) => item.id === id);
  if (!game) throw new Error("Игра для задания не найдена.");
  if (!game.online) throw new Error("Источник offline. Подготовка не начинает живой опрос диска.");
  assertGamePaths([game.root, game.pool, game.destination, stagingOf(game)]);
  if (await cancelled(store, job.id)) return cancelGame(directory, game);
  const files = await collectFiles(game.root);
  if (!files.ok) throw new Error(files.reason);
  const staging = stagingOf(game);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const file of files.files) {
    if (await cancelled(store, job.id)) return cancelGame(directory, game);
    const from = path.join(game.root, file.path);
    const to = path.join(staging, file.path);
    await mkdir(path.dirname(to), { recursive: true });
    await pipeline(createReadStream(from), createWriteStream(to));
    await chmod(to, (await stat(from)).mode);
    if (process.env.SKLAD_GAME_MUTATE_SOURCE === "1") await writeFile(from, "changed-during-copy");
  }
  if (process.env.SKLAD_GAME_EXIT === "86") process.exit(86);
  const sourceNow = await collectFiles(game.root);
  if (!sourceNow.ok) throw new Error(sourceNow.reason);
  if (!sameFiles(files.files, sourceNow.files)) throw new Error("Источник изменился во время копирования. Готовность не ставится.");
  const copied = await collectFiles(staging);
  if (!copied.ok || !sameFiles(files.files, copied.files)) throw new Error("Проверка хэшей копии не сошлась. Совпадение числа файлов этого не заменяет.");
  const marker = { id: game.id, files: files.files.length };
  await writeFile(path.join(staging, ".sklad-managed"), JSON.stringify(marker), "utf8");
  if (await directoryExists(game.destination)) throw new Error("Назначение уже есть. Чужая папка не перезаписывается.");
  await rename(staging, game.destination);
  const compact = await compactDecision(game, compactDb || game.compactDbPath);
  game.manifest = files.files;
  game.saveFingerprints = await fingerprints(game.destination, game.saves);
  game.copyVerified = true;
  game.compact = compact.state;
  game.compactReason = compact.reason;
  game.compressed = compact.compressed;
  game.ntfsSmoke = compact.ntfsSmoke;
  game.pcIntegration = compact.ntfsSmoke ? "measured" : "not-verified";
  game.logicalBytes = compact.logical;
  game.allocatedBytes = compact.allocated;
  game.wofBytes = compact.wof;
  game.ready = compact.launch;
  game.state = compact.launch ? "available" : "blocked";
  game.reason = compact.launch ? "" : compact.reason;
  game.lastSeenAt = new Date().toISOString();
  game.jobId = job.id;
  await saveGames(games, directory);
  await store.markVerified(job.id, token);
  await store.complete(job.id, token);
  return {
    processed: true,
    state: "done",
    verified: true,
    ready: game.ready,
    compressed: game.compressed,
    compact: game.compact,
    pcIntegration: game.pcIntegration,
    executed: compact.executed,
    ntfsSmoke: game.ntfsSmoke,
    logicalBytes: game.logicalBytes ?? null,
    allocatedBytes: game.allocatedBytes ?? null,
    wofBytes: game.wofBytes ?? null,
    game: publicGame(game),
    compactArgv: compact.argv,
  };
}

export async function launchGame(id: string, directory = dataDir()): Promise<Record<string, unknown>> {
  const games = await listGames(directory);
  const game = games.find((item) => item.id === id);
  if (!game) return blocked("Игры в библиотеке нет.");
  if (!game.ready || !game.copyVerified) return blocked(game.reason || "Игра не готова. Обязательный шаг не пропущен политикой.", game);
  const exe = path.resolve(game.destination, game.exe);
  if (!exe.startsWith(path.resolve(game.destination) + path.sep)) return blocked("Exe вне подготовленной копии. Произвольная команда не запускается.", game);
  const info = await lstat(exe);
  if (!info.isFile() || info.isSymbolicLink()) return blocked("Запускается только зарегистрированный файл, не ссылка.", game);
  const child = spawn(exe, game.args, { shell: false, cwd: game.destination, stdio: "ignore" });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (exit) => resolve(exit));
  });
  if (code !== 0) return blocked("Тестовый запуск завершился с ошибкой. Файлы пула не трогались.", game);
  return { ok: true, launched: true, ready: true, cleaned: false, moved: false, game: publicGame(game) };
}

export async function removeGame(id: string, directory = dataDir()): Promise<Record<string, unknown>> {
  const games = await listGames(directory);
  const game = games.find((item) => item.id === id);
  if (!game) return blocked("Игры в библиотеке нет.");
  if (game.unmanaged) return blocked("Эта игра уже была на диске и в пул для удаления не зачислена.", game);
  const eviction = evictPreparedGame("game-exit");
  if (eviction.evict) return blocked("Выход из игры ничего не переносит и не очищает.", game);
  if (!(await directoryExists(game.destination))) return blocked("Управляемой копии в пуле нет.", game);
  const marker = await readMarker(game.destination);
  if (marker !== game.id) return blocked("В назначении нет метки этой копии. Чужие файлы не удаляются.", game);
  const cold = game.copyVerified && (await sourceMatches(game)) ? "verified" : "unverified";
  const decision = removeFromGamePool(cold === "verified" ? "verified" : "unverified");
  if (!decision.clean) return blocked(decision.reason, game);
  const currentSaves = await fingerprints(game.destination, game.saves);
  if (!sameFiles(game.saveFingerprints, currentSaves)) {
    return blocked("Сохранения или изменяемые файлы в копии отличаются. Безопасного выноса нет, копия не удаляется.", game);
  }
  const extra = await strangerIn(game);
  if (extra) return blocked("В копии есть файлы, которых не было в проверенном манифесте. Они не стираются.", game);
  await removeTree(game.destination, game.pool);
  game.copyVerified = false;
  game.ready = false;
  game.state = "registered";
  game.reason = "Копия снята с тестового пула явной командой. Холодный источник на месте.";
  await saveGames(games, directory);
  const sourceLeft = await directoryExists(game.root);
  return { ok: true, removed: true, sourceKept: sourceLeft, ready: false, game: publicGame(game) };
}

function explicitIdentity(explicit: { name: string; steamAppId: number | null; exe: string }) {
  return {
    ...explicit,
    args: [] as string[],
    saves: [] as string[],
    provenance: "explicit" as const,
    confidence: explicit.steamAppId ? "medium" as const : "low" as const,
    needsReview: !explicit.steamAppId,
  };
}

async function compactDecision(game: GameRecord, compactDb: string | null): Promise<{ state: GameRecord["compact"]; reason: string; launch: boolean; argv: string[] | null; compressed: boolean; ntfsSmoke: boolean; executed: boolean; logical: number | null; allocated: number | null; wof: number | null }> {
  const empty = { argv: null, compressed: false, ntfsSmoke: false, executed: false, logical: null, allocated: null, wof: null };
  if (!game.steamAppId) {
    return { ...empty, state: "unknown", reason: "Steam ID нет. Игра в библиотеке есть. База CompactGUI для неё неизвестна: это не пропуск и не успех.", launch: false };
  }
  if (!compactDb) {
    return { ...empty, state: "unknown", reason: "База CompactGUI не задана. Неизвестная экономия не считается пропуском и не ставит сжатие выполненным.", launch: false };
  }
  const cache = cacheFromText(await readFile(compactDb, "utf8"), new Date().toISOString());
  const lookup = lookupCompactResult(cache, game.steamAppId, "XPRESS8K");
  const advice = adviseCompression({ lookup, requested: "XPRESS8K", alreadyAlgorithm: null, minSavings: MIN_SAVINGS, manualOverride: false });
  const folder = process.platform === "win32" ? game.destination : `D:\\SkladTest\\${game.id}`;
  const argv = buildCompactArgv({ os: "win32", binary: "C:\\Windows\\System32\\compact.exe", folder, algorithm: "XPRESS8K" });
  if (advice.action === "skip") {
    return { ...empty, state: "skipped", reason: `${advice.reason} Сжатие не запускалось. Это не гарантия сообщества.`, launch: true, argv };
  }
  if (advice.action !== "eligible") {
    return { ...empty, state: "unknown", reason: advice.reason, launch: false, argv };
  }
  const result = await executeCompact({
    os: process.platform,
    filesystem: process.platform === "win32" ? "NTFS" : "unknown",
    role: "game-pool",
    root: game.destination,
    escapes: [],
    algorithm: "XPRESS8K",
    binary: "C:\\Windows\\System32\\compact.exe",
  });
  return {
    state: result.compressed ? "done" : "blocked",
    reason: result.reason,
    launch: compactAllowsLaunch(result),
    argv: result.argv ?? argv,
    compressed: result.compressed,
    ntfsSmoke: result.ntfsSmoke,
    executed: result.executed,
    logical: result.logical,
    allocated: result.allocated,
    wof: result.wof,
  };
}

async function saveRegistered(
  directory: string,
  root: string,
  pool: string,
  identity: { name: string; steamAppId: number | null; exe: string; args: string[]; saves: string[]; provenance: GameRecord["provenance"]; confidence: GameRecord["confidence"]; needsReview: boolean },
  online: boolean,
): Promise<Record<string, unknown>> {
  const games = await listGames(directory);
  const id = gameId(root, identity.steamAppId, identity.name);
  const previous = games.find((item) => item.id === id);
  const game: GameRecord = {
    id,
    name: identity.name,
    steamAppId: identity.steamAppId,
    root: path.resolve(root),
    pool: path.resolve(pool),
    destination: path.join(path.resolve(pool), id),
    exe: identity.exe,
    args: identity.args,
    saves: identity.saves,
    provenance: identity.provenance,
    confidence: identity.confidence,
    needsReview: identity.needsReview,
    unmanaged: false,
    ntfsSmoke: false,
    compactDbPath: null,
    online,
    lastSeenAt: online ? new Date().toISOString() : previous?.lastSeenAt ?? null,
    location: path.resolve(root),
    state: previous?.ready ? previous.state : "registered",
    copyVerified: previous?.copyVerified ?? false,
    ready: previous?.ready ?? false,
    compact: previous?.compact ?? "not-run",
    compactReason: previous?.compactReason ?? "",
    compressed: false,
    pcIntegration: "not-verified",
    jobId: previous?.jobId ?? null,
    managed: true,
    pinned: "until-explicit-remove",
    manifest: previous?.manifest ?? [],
    saveFingerprints: previous?.saveFingerprints ?? [],
    reason: online ? "" : "Источник offline. Подготовка заблокирована, пока запись не станет доступна без опроса чужого тома.",
  };
  const next = previous ? games.map((item) => (item.id === id ? game : item)) : [...games, game];
  await saveGames(next, directory);
  return { ok: true, created: !previous, game: publicGame(game) };
}

async function readManifest(root: string): Promise<{ name: string; steamAppId: number | null; exe: string; args: string[]; saves: string[] } | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "sklad-game.json"), "utf8")) as {
      name?: string;
      steamAppId?: number;
      exe?: string;
      args?: unknown[];
      saves?: unknown[];
    };
    if (!parsed.name || !parsed.exe) return null;
    const steam = Number(parsed.steamAppId);
    return {
      name: parsed.name,
      steamAppId: Number.isInteger(steam) && steam > 0 ? steam : null,
      exe: parsed.exe,
      args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
      saves: Array.isArray(parsed.saves) ? parsed.saves.map(String) : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function fileInside(root: string, relative: string): Promise<boolean> {
  const full = path.resolve(root, relative);
  if (!full.startsWith(path.resolve(root) + path.sep)) return false;
  try {
    const info = await lstat(full);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function collectFiles(root: string): Promise<{ ok: true; files: GameFile[]; bytes: number } | { ok: false; reason: string }> {
  const files: GameFile[] = [];
  let bytes = 0;
  const walk = async (dir: string): Promise<string | null> => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === ".sklad-managed") continue;
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) return "В корне есть symlink или junction. Ссылка не обходится, копия не помечается готовой.";
      if (item.isDirectory()) {
        const nested = await walk(full);
        if (nested) return nested;
        continue;
      }
      if (!item.isFile()) return "В корне есть не обычный файл.";
      const hashed = await hashFile(full);
      bytes += hashed.size;
      if (bytes > GAME_LIMITS.maxBytes || files.length >= GAME_LIMITS.maxFiles) return "Игра больше предела тестового прогона.";
      files.push({ path: path.relative(root, full), size: hashed.size, sha256: hashed.sha256 });
    }
    return null;
  };
  const error = await walk(root);
  if (error) return { ok: false, reason: error };
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, files, bytes };
}

function sameFiles(left: readonly GameFile[], right: readonly GameFile[]): boolean {
  if (left.length !== right.length) return false;
  const byPath = new Map(right.map((file) => [file.path, file]));
  return left.every((file) => {
    const other = byPath.get(file.path);
    return other?.size === file.size && other.sha256 === file.sha256;
  });
}

async function fingerprints(root: string, saves: readonly string[]): Promise<GameFile[]> {
  const out: GameFile[] = [];
  for (const relative of saves) {
    const full = path.resolve(root, relative);
    if (!full.startsWith(path.resolve(root) + path.sep)) continue;
    try {
      const hashed = await hashFile(full);
      out.push({ path: relative, size: hashed.size, sha256: hashed.sha256 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return out;
}

async function unmanagedDestination(game: GameRecord): Promise<string | null> {
  if (!(await directoryExists(game.destination))) return null;
  const marker = await readMarker(game.destination);
  if (marker !== game.id) return "Назначение уже занято не этой копией. Чужие файлы не переносятся и не удаляются.";
  return null;
}

async function strangerIn(game: GameRecord): Promise<boolean> {
  const files = await collectFiles(game.destination);
  if (!files.ok) return true;
  const known = new Set(game.manifest.map((file) => file.path));
  return files.files.some((file) => !known.has(file.path));
}

async function sourceMatches(game: GameRecord): Promise<boolean> {
  const files = await collectFiles(game.root);
  return files.ok && sameFiles(game.manifest, files.files);
}

async function readMarker(dir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, ".sklad-managed"), "utf8")) as { id?: string };
    return parsed.id ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function stagingOf(game: GameRecord): string {
  return path.join(game.pool, `.sklad-staging-${game.id}`);
}

async function freeBytes(dir: string): Promise<number | null> {
  if (process.env.SKLAD_GAME_FREE_BYTES) {
    const value = Number(process.env.SKLAD_GAME_FREE_BYTES);
    return Number.isFinite(value) ? value : null;
  }
  try {
    const space = await statfs(dir);
    return Number(space.bavail) * Number(space.bsize);
  } catch {
    return null;
  }
}

async function cancelGame(directory: string, game: GameRecord): Promise<Record<string, unknown>> {
  await rm(stagingOf(game), { recursive: true, force: true });
  await mark(directory, game.id, (item) => {
    item.state = "blocked";
    item.ready = false;
    item.copyVerified = false;
    item.reason = "Подготовка отменена. Готовой копии нет.";
  });
  return { processed: true, state: "cancelled", ready: false, verified: false };
}

async function mark(directory: string, id: string, apply: (game: GameRecord) => void): Promise<void> {
  const games = await listGames(directory);
  const game = games.find((item) => item.id === id);
  if (!game) return;
  apply(game);
  await saveGames(games, directory);
}

async function cancelled(store: ReturnType<typeof createJobStore>, id: string): Promise<boolean> {
  const list = await store.list({ limit: 100 });
  const job = list.jobs.find((item) => item.id === id);
  return !job || job.cancelled || job.state === "error";
}

function stale(directory: string, job: Job): boolean {
  try {
    const raw = JSON.parse(readFileSync(path.join(directory, "game-leases", `${job.id}.json`), "utf8")) as { pid?: number };
    if (!raw.pid || raw.pid === process.pid) return false;
    process.kill(raw.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function writeLease(directory: string, id: string): Promise<void> {
  const dir = path.join(directory, "game-leases");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
}

function blocked(error: string, game?: GameRecord): Record<string, unknown> {
  return { ok: false, state: "blocked", ready: false, error, ...(game ? { game: publicGame(game) } : {}) };
}
