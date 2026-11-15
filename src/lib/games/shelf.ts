import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCompactArgv, DEFAULT_COMPACT_EXE } from "@/addons/media-games/compact";
import { generatedCover } from "@/lib/games/cover-art";
import { AppError } from "@/lib/app-error";
import { demoShelfGames } from "@/lib/games/demo-shelf";
import { emptyLaunchTools, planLaunch, sanitizeTools, type LaunchButton, type LaunchTools } from "@/lib/games/launch";
import { GAME_LIMITS, removeTree, samePlace } from "@/lib/games/library";
import { assertOwnerPaths, absoluteOwnerPath, insideRoot, joinStyled, localOwnerPath, pathIsLocal, pathStyle } from "@/lib/games/owner-path";
import { classifyShelfPlatform, extensionOf, PLATFORM_LABEL, SHELF_PLATFORMS, type ShelfPlatform } from "@/lib/games/platforms";
import type { ShelfCompact, ShelfGame, ShelfPlan } from "@/lib/games/shelf-model";
import { dataDir } from "@/lib/qbittorrent/store";
import { executeCompact } from "@/lib/games/compact-run";

const COVER_NAMES = ["cover.jpg", "cover.png", "cover.webp", "folder.jpg", "poster.png", "artwork.jpg"];
const MARKER = ".sklad-shelf";

interface ShelfFile {
  pool: string;
  tools: LaunchTools;
  games: ShelfGame[];
  plans: Record<string, ShelfPlan>;
}

export interface ShelfCard {
  id: string;
  name: string;
  platform: ShelfPlatform;
  platformLabel: string;
  initials: string;
  coverDataUrl: string | null;
  coverFile: string | null;
  year: number | null;
  developer: string | null;
  summary: string;
  steamAppId: number | null;
  active: "hdd" | "ssd";
  placement: string;
  hddPath: string;
  ssdPath: string;
  transfer: ShelfGame["transfer"];
  sourceKept: true;
  copyVerified: boolean;
  compact: ShelfCompact;
  compactArgv: string[] | null;
  compactReason: string;
  firmwarePath: string | null;
  keysPath: string | null;
  sample: boolean;
  launch: LaunchButton;
}

export function shelfCompactPlan(folder: string): { state: ShelfCompact; argv: string[] | null; reason: string } {
  assertOwnerPaths([folder]);
  if (pathStyle(folder) !== "win32") {
    return {
      state: "unavailable",
      argv: null,
      reason: "CompactGUI только на NTFS Windows. Копия остаётся без сжатия, оригинал на месте.",
    };
  }
  const argv = buildCompactArgv({
    os: "win32",
    binary: DEFAULT_COMPACT_EXE,
    folder: folder.replace(/\//g, "\\"),
    algorithm: "XPRESS8K",
  });
  if (process.platform !== "win32") {
    return {
      state: "planned",
      argv,
      reason: "Команда CompactGUI собрана для Windows (compact.exe /C /EXE:XPRESS8K). Здесь процесс не запускался, сжатие не засчитано.",
    };
  }
  return { state: "planned", argv, reason: "CompactGUI запущен на копии в пуле." };
}

export function applyWant(game: ShelfGame, copied: boolean, compact: { state: ShelfCompact; argv: string[] | null; reason: string }, sourceHash: string | null): ShelfGame {
  return {
    ...game,
    sourceKept: true,
    sourceHash: copied ? sourceHash : game.sourceHash,
    transfer: copied ? "on-ssd" : "to-ssd",
    active: copied ? "ssd" : "hdd",
    copyVerified: copied,
    compact: compact.state,
    compactArgv: compact.argv,
    compactReason: compact.reason,
  };
}

export function applyReturn(game: ShelfGame, restored: boolean): ShelfGame {
  if (game.transfer !== "on-ssd") {
    return { ...game, transfer: "idle", active: "hdd", sourceKept: true };
  }
  if (!restored) {
    return { ...game, transfer: "to-hdd", active: "ssd", sourceKept: true };
  }
  return {
    ...game,
    transfer: "idle",
    active: "hdd",
    copyVerified: true,
    sourceKept: true,
    compact: "not-run",
    compactArgv: null,
    compactReason: "Копия снята с SSD. Оригинал на HDD на месте.",
  };
}

export function activeContent(game: Pick<ShelfGame, "hddPath" | "ssdPath" | "active" | "launchFile" | "hddIsFile">): string {
  if (game.active === "ssd") {
    return game.launchFile ? joinStyled(game.ssdPath, game.launchFile) : game.ssdPath;
  }
  if (game.hddIsFile || !game.launchFile) return game.hddPath;
  return joinStyled(game.hddPath, game.launchFile);
}

export function gameInitials(name: string): string {
  const words = name.split(/\s+/).filter((word) => /[0-9A-Za-zА-Яа-яЁё]/.test(word));
  if (words.length === 0) return "И";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

export async function readShelf(directory = dataDir()): Promise<{
  showingSamples: boolean;
  pool: string;
  tools: LaunchTools;
  platforms: { id: ShelfPlatform; label: string; games: ShelfCard[] }[];
}> {
  const stored = await loadShelf(directory);
  const showingSamples = stored.games.length === 0;
  const games = (showingSamples ? demoShelfGames() : stored.games).map((game) => applyPlan(game, stored.plans[game.id]));
  const platforms: { id: ShelfPlatform; label: string; games: ShelfCard[] }[] = [];
  for (const id of SHELF_PLATFORMS) {
    platforms.push({
      id,
      label: PLATFORM_LABEL[id],
      games: await cards(
        games.filter((game) => game.platform === id),
        stored.tools,
      ),
    });
  }
  return { showingSamples, pool: stored.pool, tools: stored.tools, platforms };
}

export async function addShelfGame(input: unknown, directory = dataDir()): Promise<{ game: ShelfCard; shelf: Awaited<ReturnType<typeof readShelf>> }> {
  const body = recordOf(input);
  const hddPath = String(body.path || body.hddPath || "").trim();
  if (!hddPath) throw new AppError(400, "Укажите путь к игре на диске.");
  assertOwnerPaths([hddPath]);
  const name = String(body.name || "").trim() || path.basename(hddPath.replace(/\\/g, "/")).replace(/\.app$/i, "");
  const platform = await platformFor(name, hddPath);
  if (!platform) {
    throw new AppError(400, "Платформа не распознана. Игра не попадает во вкладку Windows без своего признака.");
  }
  const stored = await loadShelf(directory);
  const pool = absoluteOwnerPath(stringOf(body.pool) || stored.pool, "SSD-пул") || stored.pool;
  assertOwnerPaths([pool]);
  if (pathStyle(hddPath) !== pathStyle(pool)) {
    throw new AppError(400, "Источник и SSD-пул на разных машинах. Копия не начинается.");
  }
  const leaf = path.basename(hddPath.replace(/\\/g, "/")).replace(/\.app$/i, "") || name;
  const hddIsFile = Boolean(extensionOf(hddPath)) && !hddPath.replace(/\\/g, "/").toLowerCase().endsWith(".app");
  const ssdPath = hddIsFile ? joinStyled(pool, name) : joinStyled(pool, leaf);
  if (samePlace(hddPath, ssdPath) || samePlace(hddPath, pool)) {
    throw new AppError(400, "Источник и пул совпадают или вложены.");
  }
  const firmwarePath = absoluteOwnerPath(stringOf(body.firmwarePath), "Прошивка");
  const keysPath = absoluteOwnerPath(stringOf(body.keysPath), "Ключи");
  const sidecar = await readSidecar(hddPath);
  const coverPath = await discoverCover(hddPath);
  const launchFile = stringOf(body.exe) || sidecar.launchFile || (hddIsFile ? path.basename(hddPath.replace(/\\/g, "/")) : await inferredLaunchFile(hddPath, platform));
  const game: ShelfGame = {
    id: shelfId(platform, hddPath, name),
    name,
    platform,
    hddPath,
    ssdPath,
    pool,
    launchFile: launchFile.replace(/\\/g, "/"),
    hddIsFile,
    active: "hdd",
    transfer: "idle",
    coverPath,
    year: numberOf(body.year) ?? sidecar.year,
    developer: stringOf(body.developer) || sidecar.developer,
    summary: stringOf(body.summary) || sidecar.summary || "Игра в библиотеке. Оригинал остаётся на своём диске.",
    steamAppId: numberOf(body.steamAppId) ?? sidecar.steamAppId,
    sourceHash: null,
    copyVerified: false,
    sourceKept: true,
    compact: "not-run",
    compactArgv: null,
    compactReason: "",
    firmwarePath,
    keysPath,
    sample: false,
  };
  const games = stored.games.filter((item) => item.id !== game.id);
  games.push(game);
  await saveShelf({ ...stored, games }, directory);
  const shelf = await readShelf(directory);
  const card = shelf.platforms.flatMap((item) => item.games).find((item) => item.id === game.id);
  if (!card) throw new AppError(500, "Игра не сохранилась.");
  return { game: card, shelf };
}

export async function saveShelfTools(input: unknown, directory = dataDir()): Promise<Awaited<ReturnType<typeof readShelf>>> {
  const stored = await loadShelf(directory);
  stored.tools = sanitizeTools(input);
  await saveShelf(stored, directory);
  return readShelf(directory);
}

export async function saveGameFirmware(id: string, input: unknown, directory = dataDir()): Promise<Awaited<ReturnType<typeof readShelf>>> {
  const body = recordOf(input);
  const firmwarePath = absoluteOwnerPath(stringOf(body.firmwarePath), "Прошивка");
  const keysPath = absoluteOwnerPath(stringOf(body.keysPath), "Ключи");
  const stored = await loadShelf(directory);
  const own = stored.games.find((game) => game.id === id);
  if (own) {
    own.firmwarePath = firmwarePath;
    own.keysPath = keysPath;
  } else if (demoShelfGames().some((game) => game.id === id)) {
    stored.plans[id] = { ...planOf(stored.plans[id]), firmwarePath, keysPath };
  } else {
    throw new AppError(404, "Игры в библиотеке нет.");
  }
  await saveShelf(stored, directory);
  return readShelf(directory);
}

export async function wantToPlay(id: string, directory = dataDir()): Promise<{ ok: true; copied: boolean; sourceKept: true; game: ShelfCard; shelf: Awaited<ReturnType<typeof readShelf>> }> {
  const { stored, game, sample } = await resolveGame(id, directory);
  assertTransferPaths(game);
  let copied = false;
  let sourceHash: string | null = null;
  if (pathIsLocal(game.hddPath) && pathIsLocal(game.ssdPath)) {
    const receipt = await copyIntoPool(game);
    copied = true;
    sourceHash = receipt.hash;
  }
  const compact = await pressCompact(game.ssdPath);
  const next = applyWant(game, copied, compact, sourceHash);
  await persistGame(stored, next, sample, directory);
  const shelf = await readShelf(directory);
  const card = findCard(shelf, id);
  return { ok: true, copied, sourceKept: true, game: card, shelf };
}

export async function returnToHdd(id: string, directory = dataDir()): Promise<{ ok: true; sourceKept: true; removedSsd: boolean; game: ShelfCard; shelf: Awaited<ReturnType<typeof readShelf>> }> {
  const { stored, game, sample } = await resolveGame(id, directory);
  assertTransferPaths(game);
  let restored = false;
  if (game.transfer === "on-ssd" && pathIsLocal(game.hddPath) && pathIsLocal(game.ssdPath)) {
    await restoreColdCopy(game);
    await removePoolCopy(game);
    restored = true;
  } else if (game.transfer !== "on-ssd") {
    restored = false;
  }
  const next = applyReturn(game, restored || game.transfer !== "on-ssd");
  await persistGame(stored, next, sample, directory);
  const shelf = await readShelf(directory);
  return { ok: true, sourceKept: true, removedSsd: restored && game.transfer === "on-ssd", game: findCard(shelf, id), shelf };
}

export async function launchShelfGame(
  id: string,
  directory = dataDir(),
  spawnImpl?: (file: string, args: string[]) => void,
): Promise<{ ok: boolean; launched: boolean; button: LaunchButton; error: string | null }> {
  const { game } = await resolveGame(id, directory);
  const stored = await loadShelf(directory);
  const button = planLaunch({
    name: game.name,
    platform: game.platform,
    contentPath: activeContent(game),
    tools: stored.tools,
    firmwarePath: game.firmwarePath,
    keysPath: game.keysPath,
  });
  if (!button.ready || button.argv.length === 0) {
    return { ok: false, launched: false, button, error: button.reason };
  }
  if (button.argv.some((arg) => arg.includes("://"))) {
    return { ok: false, launched: false, button, error: "Скачивание запрещено. Запуск не начат." };
  }
  assertOwnerPaths(button.argv);
  const executable = button.argv[0]!;
  if (!pathIsLocal(executable)) {
    return {
      ok: false,
      launched: false,
      button,
      error: `${button.machineLabel} запустит ${button.program}. Эта машина программу не открывает и не скачивает.`,
    };
  }
  let info;
  try {
    info = await lstat(executable);
  } catch {
    return { ok: false, launched: false, button, error: "Программы нет по указанному пути. Скачивание не выполняется." };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return { ok: false, launched: false, button, error: "Запускается только файл программы, не ссылка." };
  }
  const start = spawnImpl ?? defaultSpawn;
  start(executable, button.argv.slice(1));
  return { ok: true, launched: true, button, error: null };
}

async function pressCompact(folder: string): Promise<{ state: ShelfCompact; argv: string[] | null; reason: string }> {
  const plan = shelfCompactPlan(folder);
  if (plan.state !== "planned" || process.platform !== "win32" || !plan.argv) return plan;
  const result = await executeCompact({
    os: "win32",
    filesystem: "NTFS",
    role: "game-pool",
    root: folder,
    escapes: [],
    algorithm: "XPRESS8K",
    binary: plan.argv[0],
  });
  if (result.compressed) return { state: "done", argv: result.argv, reason: result.reason };
  return { state: "planned", argv: result.argv ?? plan.argv, reason: result.reason };
}

async function copyIntoPool(game: ShelfGame): Promise<{ hash: string }> {
  const sourceInfo = await lstat(game.hddPath).catch(() => null);
  if (!sourceInfo) throw new AppError(400, "Источника нет на этой машине. Оригинал не трогался.");
  if (sourceInfo.isSymbolicLink()) throw new AppError(400, "Ссылки в папке игры не копируются.");
  const files = await listOwned(game.hddPath);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > GAME_LIMITS.maxFiles || bytes > GAME_LIMITS.maxBytes) {
    throw new AppError(400, "Папка больше прямой копии. Оригинал не трогался, чужие файлы не стирались.");
  }
  if (!insideRoot(game.pool, game.ssdPath)) throw new AppError(400, "Назначение вне SSD-пула.");
  await assertDestinationEmpty(game);
  await mkdir(game.ssdPath, { recursive: true });
  await writeFile(path.join(game.ssdPath, MARKER), game.id, { mode: 0o600 });
  try {
    for (const file of files) {
      const dest = path.join(game.ssdPath, ...file.rel.split("/"));
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(file.full, dest);
    }
    const sourceHash = await hashTree(game.hddPath);
    const destHash = await hashTree(game.ssdPath);
    if (sourceHash !== destHash) {
      await removeTree(game.ssdPath, game.pool);
      throw new AppError(400, "SHA-256 копии не совпал. Копия в пуле снята, оригинал на месте.");
    }
    return { hash: sourceHash };
  } catch (error) {
    if (error instanceof AppError) throw error;
    await removeTree(game.ssdPath, game.pool).catch(() => undefined);
    throw new AppError(400, "Копия не собрана. Оригинал не трогался.");
  }
}

async function restoreColdCopy(game: ShelfGame): Promise<void> {
  if (!game.sourceHash) throw new AppError(400, "Холодная копия ещё не проверена. SSD не очищается.");
  const hdd = await lstat(game.hddPath).catch(() => null);
  if (!hdd) await copyBack(game);
  else if (hdd.isSymbolicLink()) throw new AppError(400, "Холодная копия — ссылка. SSD не стирается.");
  const cold = await hashTree(game.hddPath);
  if (cold !== game.sourceHash) {
    throw new AppError(400, "Холодная копия не совпала по SHA-256. SSD не стирается, оригинал не удаляется.");
  }
}

async function copyBack(game: ShelfGame): Promise<void> {
  if (game.hddIsFile) {
    await mkdir(path.dirname(game.hddPath), { recursive: true });
    await copyFile(path.join(game.ssdPath, path.basename(game.hddPath)), game.hddPath);
    return;
  }
  await mkdir(game.hddPath, { recursive: true });
  for (const file of await listOwned(game.ssdPath)) {
    const dest = path.join(game.hddPath, ...file.rel.split("/"));
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(file.full, dest);
  }
}

async function removePoolCopy(game: ShelfGame): Promise<void> {
  const markerPath = path.join(game.ssdPath, MARKER);
  const marker = await readFile(markerPath, "utf8").catch(() => "");
  if (marker.trim() !== game.id) throw new AppError(400, "В пуле нет метки этой копии. Чужие файлы не удаляются.");
  await removeTree(game.ssdPath, game.pool);
}

async function assertDestinationEmpty(game: ShelfGame): Promise<void> {
  const info = await lstat(game.ssdPath).catch(() => null);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AppError(400, "В назначении уже лежит файл. Он не затирается и не удаляется.");
  }
  const items = await readdir(game.ssdPath);
  if (items.length === 0) return;
  const marker = await readFile(path.join(game.ssdPath, MARKER), "utf8").catch(() => "");
  if (marker.trim() === game.id) {
    await removeTree(game.ssdPath, game.pool);
    return;
  }
  throw new AppError(400, "В назначении уже есть чужие файлы. Они не удаляются.");
}

async function listOwned(root: string, strict = true): Promise<{ rel: string; full: string; size: number }[]> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) {
    if (!strict) return [];
    throw new AppError(400, "Ссылки в папке игры не копируются.");
  }
  if (info.isFile()) {
    return [{ rel: path.basename(root), full: root, size: info.size }];
  }
  const out: { rel: string; full: string; size: number }[] = [];
  const walk = async (dir: string) => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === MARKER) continue;
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        if (!strict) continue;
        throw new AppError(400, "Ссылки в папке игры не копируются.");
      }
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) {
        const file = await stat(full);
        out.push({ rel, full, size: file.size });
      }
    }
  };
  await walk(root);
  return out;
}

async function hashTree(root: string): Promise<string> {
  const files = await listOwned(root);
  const lines: string[] = [];
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    lines.push(`${file.rel}\0${await digest(file.full)}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function discoverCover(root: string): Promise<string | null> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return null;
  const dir = info.isDirectory() ? root : path.dirname(root);
  for (const name of COVER_NAMES) {
    const full = path.join(/*turbopackIgnore: true*/ dir, name);
    if (!insideRoot(dir, full)) continue;
    const file = await lstat(full).catch(() => null);
    if (file?.isFile() && !file.isSymbolicLink()) return full;
  }
  return null;
}

async function readSidecar(root: string): Promise<{ developer: string | null; year: number | null; summary: string | null; steamAppId: number | null; launchFile: string | null }> {
  const empty = { developer: null, year: null, summary: null, steamAppId: null, launchFile: null };
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return empty;
  const dir = info.isDirectory() ? root : path.dirname(root);
  const file = path.join(dir, "sklad.json");
  if (!insideRoot(dir, file)) return empty;
  const raw = await readFile(file, "utf8").catch(() => "");
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      developer: typeof parsed.developer === "string" ? parsed.developer.trim() : null,
      year: numberOf(parsed.year),
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : null,
      steamAppId: numberOf(parsed.steamAppId),
      launchFile: typeof parsed.launchFile === "string" ? parsed.launchFile.trim() : null,
    };
  } catch {
    return empty;
  }
}

async function coverData(filePath: string | null): Promise<string | null> {
  if (!filePath) return null;
  const info = await lstat(filePath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 180_000) return null;
  const ext = extensionOf(filePath);
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "";
  if (!mime) return null;
  const bytes = await readFile(filePath);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function platformFor(name: string, hddPath: string): Promise<ShelfPlatform | null> {
  const direct = classifyShelfPlatform({ name, path: hddPath });
  if (direct) return direct;
  const ambiguousExt = new Set(["iso", "chd", "cue", "pkg"]);
  if (pathIsLocal(hddPath)) {
    const info = await lstat(hddPath).catch(() => null);
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      const files = await listOwned(hddPath, false).catch(() => []);
      let windows = false;
      let ambiguous = false;
      for (const file of files) {
        const found = classifyShelfPlatform({ name, path: file.rel });
        if (found && found !== "windows") return found;
        if (found === "windows") windows = true;
        if (file.rel.toLowerCase().includes(".app/")) return "macos";
        if (!found && ambiguousExt.has(extensionOf(file.rel))) ambiguous = true;
      }
      if (windows && !ambiguous) return "windows";
      if (ambiguous) return null;
    }
  }
  if (pathStyle(hddPath) === "win32" && !ambiguousExt.has(extensionOf(hddPath))) return "windows";
  return null;
}

async function inferredLaunchFile(root: string, platform: ShelfPlatform): Promise<string> {
  if (!pathIsLocal(root)) return "";
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return "";
  const rels = (await listOwned(root, false).catch(() => [])).map((file) => file.rel);
  const match = (exts: string[]) => rels.find((rel) => exts.includes(extensionOf(rel))) || "";
  if (platform === "psp") return match(["cso", "pbp", "iso"]);
  if (platform === "ps2") return match(["iso", "chd", "bin", "cue"]);
  if (platform === "ps4") return match(["pkg", "iso"]);
  if (platform === "switch") return match(["nsp", "xci", "nsz", "nca"]);
  if (platform === "windows") return rels.find((rel) => rel.toLowerCase().endsWith(".exe") && !/crashhandler|unitycrash/i.test(rel)) || "";
  if (platform === "macos") return rels.find((rel) => rel.toLowerCase().includes(".app/")) || "";
  return "";
}

function assertTransferPaths(game: ShelfGame): void {
  assertOwnerPaths([game.hddPath, game.ssdPath, game.pool]);
  if (pathStyle(game.hddPath) !== pathStyle(game.pool) || pathStyle(game.ssdPath) !== pathStyle(game.pool)) {
    throw new AppError(400, "Источник и SSD-пул на разных машинах. Копия не начинается.");
  }
  if (samePlace(game.hddPath, game.ssdPath) || samePlace(game.hddPath, game.pool)) {
    throw new AppError(400, "Источник и пул совпадают или вложены.");
  }
  localOwnerPath(game.firmwarePath, "Прошивка");
  localOwnerPath(game.keysPath, "Ключи");
}

async function resolveGame(id: string, directory: string): Promise<{ stored: ShelfFile; game: ShelfGame; sample: boolean }> {
  const stored = await loadShelf(directory);
  const own = stored.games.find((game) => game.id === id);
  if (own) return { stored, game: applyPlan(own, stored.plans[id]), sample: false };
  const sample = demoShelfGames().find((game) => game.id === id);
  if (sample) return { stored, game: applyPlan(sample, stored.plans[id]), sample: true };
  throw new AppError(404, "Игры в библиотеке нет.");
}

async function persistGame(stored: ShelfFile, game: ShelfGame, sample: boolean, directory: string): Promise<void> {
  const plan = planFrom(game);
  if (sample) {
    stored.plans[game.id] = plan;
  } else {
    const index = stored.games.findIndex((item) => item.id === game.id);
    if (index < 0) stored.games.push({ ...game, sample: false });
    else stored.games[index] = { ...game, sample: false };
  }
  await saveShelf(stored, directory);
}

function planFrom(game: ShelfGame): ShelfPlan {
  return {
    active: game.active,
    transfer: game.transfer,
    compact: game.compact,
    compactArgv: game.compactArgv,
    compactReason: game.compactReason,
    sourceKept: true,
    copyVerified: game.copyVerified,
    sourceHash: game.sourceHash,
    firmwarePath: game.firmwarePath,
    keysPath: game.keysPath,
  };
}

function planOf(plan: ShelfPlan | undefined): ShelfPlan {
  return (
    plan ?? {
      active: "hdd",
      transfer: "idle",
      compact: "not-run",
      compactArgv: null,
      compactReason: "",
      sourceKept: true,
      copyVerified: false,
      sourceHash: null,
      firmwarePath: null,
      keysPath: null,
    }
  );
}

function applyPlan(game: ShelfGame, plan: ShelfPlan | undefined): ShelfGame {
  if (!plan) return game;
  return { ...game, ...plan, sourceKept: true, id: game.id, sample: game.sample, name: game.name, platform: game.platform };
}

async function cards(games: ShelfGame[], tools: LaunchTools): Promise<ShelfCard[]> {
  const out: ShelfCard[] = [];
  for (const game of games) {
    out.push({
      id: game.id,
      name: game.name,
      platform: game.platform,
      platformLabel: PLATFORM_LABEL[game.platform],
      initials: gameInitials(game.name),
      coverDataUrl: (await coverData(game.coverPath)) ?? generatedCover({ name: game.name, platform: game.platform, year: game.year }),
      coverFile: game.coverPath ? path.basename(game.coverPath) : null,
      year: game.year,
      developer: game.developer,
      summary: game.summary,
      steamAppId: game.steamAppId,
      active: game.active,
      placement: placementLabel(game),
      hddPath: game.hddPath,
      ssdPath: game.ssdPath,
      transfer: game.transfer,
      sourceKept: true,
      copyVerified: game.copyVerified,
      compact: game.compact,
      compactArgv: game.compactArgv,
      compactReason: game.compactReason,
      firmwarePath: game.firmwarePath,
      keysPath: game.keysPath,
      sample: game.sample,
      launch: planLaunch({
        name: game.name,
        platform: game.platform,
        contentPath: activeContent(game),
        tools,
        firmwarePath: game.firmwarePath,
        keysPath: game.keysPath,
      }),
    });
  }
  return out;
}

function placementLabel(game: ShelfGame): string {
  if (game.transfer === "on-ssd") return "В пуле на SSD";
  if (game.transfer === "to-ssd") return "Ждёт копирования на SSD";
  if (game.transfer === "to-hdd") return "Возврат на HDD поставлен";
  return "На HDD";
}

function findCard(shelf: Awaited<ReturnType<typeof readShelf>>, id: string): ShelfCard {
  const card = shelf.platforms.flatMap((item) => item.games).find((item) => item.id === id);
  if (!card) throw new AppError(404, "Игры в библиотеке нет.");
  return card;
}

async function loadShelf(directory: string): Promise<ShelfFile> {
  try {
    const parsed = JSON.parse(await readFile(shelfPath(directory), "utf8")) as Partial<ShelfFile>;
    return {
      pool: typeof parsed.pool === "string" && parsed.pool.trim() ? parsed.pool : "C:\\Games",
      tools: sanitizeTools(parsed.tools ?? emptyLaunchTools()),
      games: Array.isArray(parsed.games) ? parsed.games.filter(isShelfGame).map(fillGame) : [],
      plans: parsed.plans && typeof parsed.plans === "object" ? parsed.plans : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { pool: "C:\\Games", tools: emptyLaunchTools(), games: [], plans: {} };
    }
    throw error;
  }
}

async function saveShelf(shelf: ShelfFile, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = shelfPath(directory);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(shelf, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

function shelfPath(directory: string): string {
  return path.join(directory, "game-shelf.json");
}

function fillGame(game: ShelfGame): ShelfGame {
  return { ...game, sourceKept: true, sample: false, transfer: game.transfer || "idle", compact: game.compact || "not-run" };
}

function isShelfGame(value: unknown): value is ShelfGame {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<ShelfGame>;
  return typeof game.id === "string" && typeof game.hddPath === "string" && typeof game.platform === "string";
}

function shelfId(platform: string, hddPath: string, name: string): string {
  return `shelf-${createHash("sha256").update(`${platform}|${hddPath}|${name}`).digest("hex").slice(0, 12)}`;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOf(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) ? number : null;
}

function defaultSpawn(file: string, args: string[]): void {
  const child = spawn(file, args, { shell: false, detached: true, stdio: "ignore" });
  child.unref();
}
