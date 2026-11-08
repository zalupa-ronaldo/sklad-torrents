import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

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
  provenance: "manifest" | "explicit";
  confidence: "high" | "medium";
  online: boolean;
  lastSeenAt: string | null;
  location: string;
  state: "registered" | "preparing" | "available" | "blocked";
  copyVerified: boolean;
  ready: boolean;
  compact: "skipped" | "blocked" | "hold" | "not-run";
  compactReason: string;
  compressed: false;
  pcIntegration: "not-verified";
  jobId: string | null;
  managed: true;
  pinned: "until-explicit-remove";
  manifest: GameFile[];
  saveFingerprints: GameFile[];
  reason: string;
}

export function publicGame(game: GameRecord) {
  return {
    id: game.id,
    name: game.name,
    steamAppId: game.steamAppId,
    state: game.state,
    online: game.online,
    location: game.location,
    lastSeenAt: game.lastSeenAt,
    ready: game.ready,
    copyVerified: game.copyVerified,
    compact: game.compact,
    compressed: game.compressed,
    pcIntegration: game.pcIntegration,
    reason: game.reason,
    pinned: game.pinned,
    provenance: game.provenance,
    confidence: game.confidence,
    jobId: game.jobId,
  };
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
}): { ok: true; name: string; steamAppId: number | null; exe: string; args: string[]; saves: string[]; provenance: "manifest" | "explicit"; confidence: "high" | "medium" } | { ok: false; reason: string } {
  if (input.manifest && input.manifest.steamAppId && input.manifest.exe && input.exeInside) {
    return {
      ok: true,
      name: input.manifest.name,
      steamAppId: input.manifest.steamAppId,
      exe: input.manifest.exe,
      args: input.manifest.args,
      saves: input.manifest.saves,
      provenance: "manifest",
      confidence: "high",
    };
  }
  if (input.explicit?.name && input.explicit.steamAppId && input.explicit.exe && input.exeInside) {
    return {
      ok: true,
      name: input.explicit.name,
      steamAppId: input.explicit.steamAppId,
      exe: input.explicit.exe,
      args: [],
      saves: [],
      provenance: "explicit",
      confidence: "medium",
    };
  }
  return { ok: false, reason: "Корень игры не подтверждён. Одного exe или имени папки недостаточно. Нужен sklad-game.json или явные имя, Steam ID и exe внутри корня." };
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
      games: Array.isArray(parsed.games) ? parsed.games.filter(isGame) : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], games: [] };
    throw error;
  }
}

function libraryPath(directory: string): string {
  return path.join(directory, "library.json");
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
