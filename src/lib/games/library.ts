import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

import { generatedCover } from "@/lib/games/cover-art";
import { emptyLaunchTools, planLaunch, type LaunchButton, type LaunchTools } from "@/lib/games/launch";
import { joinStyled } from "@/lib/games/owner-path";
import { classifyShelfPlatform, PLATFORM_LABEL, SHELF_PLATFORMS, type ShelfPlatform } from "@/lib/games/platforms";
import { assertEncodePaths, pathInside } from "@/lib/transcode/encode-plan";
import { dataDir } from "@/lib/qbittorrent/store";

export const GAME_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxFiles: 200,
} as const;

export interface GameFile {
  path: string;
  size: number;
  sha256: string;
}

export interface GameRecord {
  id: string;
  name: string;
  steamAppId: number | null;
  root: string;
  pool: string;
  destination: string;
  exe: string;
  args: string[];
  saves: string[];
  provenance: "manifest" | "explicit" | "steam-manifest" | "epic-manifest" | "gog-manifest" | "offline-index";
  confidence: "high" | "medium" | "low";
  needsReview: boolean;
  unmanaged: boolean;
  online: boolean;
  lastSeenAt: string | null;
  location: string;
  state: "registered" | "preparing" | "available" | "blocked";
  copyVerified: boolean;
  ready: boolean;
  compact: "skipped" | "blocked" | "hold" | "unknown" | "done" | "not-run";
  compactReason: string;
  compressed: boolean;
  /** True only after this Windows process measured the owned root. A cloud run stays false. */
  ntfsSmoke: boolean;
  pcIntegration: "not-verified" | "measured";
  logicalBytes?: number | null;
  allocatedBytes?: number | null;
  wofBytes?: number | null;
  compactDbPath: string | null;
  jobId: string | null;
  managed: true;
  pinned: "until-explicit-remove";
  manifest: GameFile[];
  saveFingerprints: GameFile[];
  reason: string;
  developer?: string | null;
  year?: number | null;
  summary?: string | null;
  coverPath?: string | null;
}

export interface PublicGame {
  id: string;
  name: string;
  steamAppId: number | null;
  platform: ShelfPlatform | null;
  platformLabel: string | null;
  developer: string | null;
  year: number | null;
  summary: string | null;
  coverPath: string | null;
  coverDataUrl: string | null;
  launch: LaunchButton | null;
  state: GameRecord["state"];
  online: boolean;
  location: string;
  lastSeenAt: string | null;
  ready: boolean;
  copyVerified: boolean;
  compact: GameRecord["compact"];
  compressed: boolean;
  ntfsSmoke: boolean;
  logicalBytes: number | null;
  allocatedBytes: number | null;
  wofBytes: number | null;
  needsReview: boolean;
  unmanaged: boolean;
  pcIntegration: GameRecord["pcIntegration"];
  reason: string;
  pinned: GameRecord["pinned"];
  provenance: GameRecord["provenance"];
  confidence: GameRecord["confidence"];
  jobId: string | null;
}

export function libraryPlatform(game: Pick<GameRecord, "name" | "root" | "location" | "exe" | "steamAppId" | "provenance">): ShelfPlatform | null {
  const hinted = classifyShelfPlatform({
    name: game.name,
    path: [game.root, game.location, game.exe].filter(Boolean).join("/"),
  });
  if (hinted) return hinted;
  if (game.steamAppId || game.provenance === "steam-manifest" || game.provenance === "gog-manifest" || game.provenance === "epic-manifest") {
    return "windows";
  }
  return null;
}

export function publicGame(game: GameRecord): PublicGame {
  return presentGame(game, emptyLaunchTools());
}

function presentGame(game: GameRecord, tools: LaunchTools): PublicGame {
  const platform = libraryPlatform(game);
  const year = typeof game.year === "number" ? game.year : null;
  return {
    id: game.id,
    name: game.name,
    steamAppId: game.steamAppId,
    platform,
    platformLabel: platform ? PLATFORM_LABEL[platform] : null,
    developer: game.developer?.trim() || null,
    year,
    summary: game.summary?.trim() || null,
    coverPath: game.coverPath ?? null,
    coverDataUrl: platform ? generatedCover({ name: game.name, platform, year }) : null,
    launch: platform
      ? planLaunch({
          name: game.name,
          platform,
          contentPath: contentPath(game),
          tools,
          firmwarePath: null,
          keysPath: null,
        })
      : null,
    state: game.state,
    online: game.online,
    location: game.location,
    lastSeenAt: game.lastSeenAt,
    ready: game.ready,
    copyVerified: game.copyVerified,
    compact: game.compact,
    compressed: game.compressed,
    ntfsSmoke: game.ntfsSmoke,
    logicalBytes: game.logicalBytes ?? null,
    allocatedBytes: game.allocatedBytes ?? null,
    wofBytes: game.wofBytes ?? null,
    needsReview: game.needsReview,
    unmanaged: game.unmanaged,
    pcIntegration: game.pcIntegration,
    reason: game.reason,
    pinned: game.pinned,
    provenance: game.provenance,
    confidence: game.confidence,
    jobId: game.jobId,
  };
}

/** Six platform tabs. A game without its own platform is left out of Windows. */
export function libraryTabs(games: readonly GameRecord[], tools: LaunchTools = emptyLaunchTools()): { id: ShelfPlatform; label: string; games: PublicGame[] }[] {
  const cards = games.map((game) => presentGame(game, tools));
  return SHELF_PLATFORMS.map((id) => ({
    id,
    label: PLATFORM_LABEL[id],
    games: cards.filter((game) => game.platform === id),
  }));
}

function contentPath(game: GameRecord): string {
  const root = game.location || game.root;
  if (!game.exe) return root;
  if (/^[A-Za-z]:[\\/]/.test(game.exe) || game.exe.startsWith("/") || game.exe.includes("\\") || game.exe.includes("/")) return game.exe;
  return joinStyled(root, game.exe);
}

export function assertGamePaths(paths: readonly string[]): void {
  assertEncodePaths(paths);
}

export function coldGameBlocksDelete(games: readonly Pick<GameRecord, "root">[], target: string): boolean {
  const file = path.resolve(target);
  return games.some((game) => {
    const root = path.resolve(game.root);
    return file === root || pathInside(root, file);
  });
}

export async function listGames(directory = dataDir()): Promise<GameRecord[]> {
  const parsed = await readLibrary(directory);
  return parsed.games.filter(isGame);
}

export async function saveGames(games: readonly GameRecord[], directory = dataDir()): Promise<void> {
  const file = libraryPath(directory);
  const parsed = await readLibrary(directory);
  await mkdir(directory, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ entries: parsed.entries, games }, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

export function samePlace(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || pathInside(a, b) || pathInside(b, a);
}

export function assessRegistration(input: {
  manifest: { name: string; steamAppId: number | null; exe: string; args: string[]; saves: string[] } | null;
  explicit: { name: string; steamAppId: number | null; exe: string } | null;
  exeInside: boolean;
}): { ok: true; name: string; steamAppId: number | null; exe: string; args: string[]; saves: string[]; provenance: "manifest" | "explicit"; confidence: "high" | "medium" | "low"; needsReview: boolean } | { ok: false; reason: string } {
  if (input.manifest?.exe && input.exeInside) {
    const steam = input.manifest.steamAppId;
    return {
      ok: true,
      name: input.manifest.name,
      steamAppId: steam,
      exe: input.manifest.exe,
      args: input.manifest.args,
      saves: input.manifest.saves,
      provenance: "manifest",
      confidence: steam ? "high" : "medium",
      needsReview: !steam,
    };
  }
  if (input.explicit?.name && input.explicit.exe && input.exeInside) {
    const steam = input.explicit.steamAppId;
    return {
      ok: true,
      name: input.explicit.name,
      steamAppId: steam,
      exe: input.explicit.exe,
      args: [],
      saves: [],
      provenance: "explicit",
      confidence: steam ? "medium" : "low",
      needsReview: !steam,
    };
  }
  return { ok: false, reason: "Корень игры не подтверждён. Одного exe или имени папки недостаточно. Нужен известный манифест или явные имя и exe внутри корня." };
}

export async function hashFile(file: string): Promise<GameFile> {
  const info = await stat(file);
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return { path: file, size: info.size, sha256: hash.digest("hex") };
}

export async function readLibrary(directory: string): Promise<{ entries: unknown[]; games: GameRecord[] }> {
  try {
    const parsed = JSON.parse(await readFile(libraryPath(directory), "utf8")) as { entries?: unknown[]; games?: unknown[] };
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      games: Array.isArray(parsed.games) ? parsed.games.filter(isGame).map(fillGame) : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], games: [] };
    throw error;
  }
}

function libraryPath(directory: string): string {
  return path.join(directory, "library.json");
}

function fillGame(game: GameRecord): GameRecord {
  return {
    ...game,
    needsReview: game.needsReview === true,
    unmanaged: game.unmanaged === true,
    ntfsSmoke: game.ntfsSmoke === true,
    pcIntegration: game.pcIntegration === "measured" ? "measured" : "not-verified",
    compactDbPath: game.compactDbPath ?? null,
    compressed: game.compressed === true,
  };
}

function isGame(value: unknown): value is GameRecord {
  if (!value || typeof value !== "object") return false;
  const game = value as Partial<GameRecord>;
  return typeof game.id === "string" && typeof game.root === "string" && game.managed === true;
}

export async function directoryExists(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    return info.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function removeTree(target: string, pool: string): Promise<void> {
  const real = path.resolve(target);
  if (!pathInside(path.resolve(pool), real)) throw new Error("Удаление вне тестового пула запрещено.");
  await rm(real, { recursive: true, force: false });
}

export function gameId(root: string, steamAppId: number | null, name: string): string {
  const digest = createHash("sha256").update(`${path.resolve(root)}|${steamAppId ?? ""}|${name}`).digest("hex").slice(0, 12);
  return `game-${digest}`;
}

export async function listRelative(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full);
      if (item.isSymbolicLink()) {
        out.push(rel);
        continue;
      }
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) out.push(rel);
    }
  };
  await walk(root);
  return out;
}
