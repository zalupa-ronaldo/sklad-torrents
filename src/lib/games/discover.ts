import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { assertEncodePaths } from "@/lib/transcode/encode-plan";
import { gameId, listGames, saveGames, type GameRecord } from "@/lib/games/library";
import { dataDir } from "@/lib/qbittorrent/store";

export interface DiscoveredGame {
  name: string;
  steamAppId: number | null;
  root: string;
  exe: string;
  provenance: GameRecord["provenance"];
  confidence: GameRecord["confidence"];
  needsReview: boolean;
  unmanaged: boolean;
  source: string;
}

/** Paths already listed by an offline index. Does not open a volume. */
export function candidatesFromIndex(paths: readonly string[]): DiscoveredGame[] {
  const found: DiscoveredGame[] = [];
  for (const raw of paths) {
    if (forbiddenPath(raw)) continue;
    const manifest = /appmanifest_(\d+)\.acf/i.exec(raw.replace(/\\/g, "/"));
    if (!manifest) continue;
    const steamAppId = Number(manifest[1]);
    const root = raw.replace(/\\/g, "/");
    found.push({
      name: `Steam ${steamAppId}`,
      steamAppId: Number.isInteger(steamAppId) ? steamAppId : null,
      root,
      exe: "",
      provenance: "offline-index",
      confidence: "low",
      needsReview: true,
      unmanaged: driveLetter(raw) === "C",
      source: raw,
    });
  }
  return dedupe(found);
}

export async function discoverInRoot(root: string): Promise<DiscoveredGame[]> {
  if (forbiddenPath(root)) throw new Error("E и Z не открываются. Корень библиотеки не читается.");
  assertEncodePaths([root]);
  const found: DiscoveredGame[] = [];
  await walk(root, 0, found);
  return dedupe(found);
}

export async function importDiscovered(root: string, directory = dataDir()): Promise<{ added: number; existing: number; games: DiscoveredGame[] }> {
  const discovered = await discoverInRoot(root);
  const games = await listGames(directory);
  let added = 0;
  let existing = 0;
  for (const item of discovered) {
    const id = gameId(item.root, item.steamAppId, item.name);
    if (games.some((game) => game.id === id)) {
      existing += 1;
      continue;
    }
    games.push(recordFrom(item, id));
    added += 1;
  }
  await saveGames(games, directory);
  return { added, existing, games: discovered };
}

async function walk(dir: string, depth: number, found: DiscoveredGame[]): Promise<void> {
  if (depth > 5) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (forbiddenPath(full)) continue;
    if (entry.isDirectory()) {
      await walk(full, depth + 1, found);
      continue;
    }
    if (!entry.isFile()) continue;
    const parsed = await parseManifest(full);
    if (parsed) found.push(parsed);
  }
}

async function parseManifest(file: string): Promise<DiscoveredGame | null> {
  const base = path.basename(file);
  if (/^appmanifest_\d+\.acf$/i.test(base)) return parseSteam(file);
  if (/^goggame-.*\.info$/i.test(base)) return parseGog(file);
  if (base.endsWith(".item") || /^Manifest_.*\.json$/i.test(base)) return parseEpic(file);
  return null;
}

async function parseSteam(file: string): Promise<DiscoveredGame | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  const appid = Number(/"appid"\s+"(\d+)"/.exec(text)?.[1]);
  const name = /"name"\s+"([^"]+)"/.exec(text)?.[1] || "";
  const installdir = /"installdir"\s+"([^"]+)"/.exec(text)?.[1] || "";
  if (!name || !installdir || !Number.isInteger(appid)) return null;
  const steamapps = path.dirname(file);
  return {
    name,
    steamAppId: appid,
    root: path.join(steamapps, "common", installdir),
    exe: "",
    provenance: "steam-manifest",
    confidence: "high",
    needsReview: false,
    unmanaged: driveLetter(file) === "C",
    source: file,
  };
}

async function parseEpic(file: string): Promise<DiscoveredGame | null> {
  const parsed = await readJson(file);
  const name = stringField(parsed, "DisplayName");
  const root = stringField(parsed, "InstallLocation");
  if (!name || !root || forbiddenPath(root)) return null;
  return {
    name,
    steamAppId: null,
    root,
    exe: "",
    provenance: "epic-manifest",
    confidence: "medium",
    needsReview: true,
    unmanaged: driveLetter(root) === "C",
    source: file,
  };
}

async function parseGog(file: string): Promise<DiscoveredGame | null> {
  const parsed = await readJson(file);
  const name = stringField(parsed, "name");
  if (!name) return null;
  const tasks = Array.isArray(parsed.playTasks) ? parsed.playTasks : [];
  const task = tasks.find((item) => item && typeof item === "object" && (item as { category?: string }).category === "game") as { path?: string } | undefined;
  const relative = task?.path || "";
  return {
    name,
    steamAppId: null,
    root: path.dirname(file),
    exe: relative,
    provenance: "gog-manifest",
    confidence: "medium",
    needsReview: true,
    unmanaged: driveLetter(file) === "C",
    source: file,
  };
}

function recordFrom(item: DiscoveredGame, id: string): GameRecord {
  return {
    id,
    name: item.name,
    steamAppId: item.steamAppId,
    root: item.root,
    pool: "",
    destination: "",
    exe: item.exe,
    args: [],
    saves: [],
    provenance: item.provenance,
    confidence: item.confidence,
    needsReview: item.needsReview,
    unmanaged: item.unmanaged,
    online: false,
    lastSeenAt: null,
    location: item.root,
    state: "registered",
    copyVerified: false,
    ready: false,
    compact: item.steamAppId ? "not-run" : "unknown",
    compactReason: item.steamAppId ? "" : "Steam ID нет. База CompactGUI для этой игры неизвестна.",
    compressed: false,
    ntfsSmoke: false,
    pcIntegration: "not-verified",
    compactDbPath: null,
    jobId: null,
    managed: true,
    pinned: "until-explicit-remove",
    manifest: [],
    saveFingerprints: [],
    reason: item.unmanaged ? "Игра уже лежит на C: и в пул для удаления не зачислена." : "Найдена по манифесту. Копия не делалась.",
  };
}

function dedupe(items: DiscoveredGame[]): DiscoveredGame[] {
  const seen = new Set<string>();
  const out: DiscoveredGame[] = [];
  for (const item of items) {
    const key = `${item.provenance}|${item.steamAppId ?? ""}|${item.root}|${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function forbiddenPath(value: string): boolean {
  return /^(?:\\\\\?\\)?[Ee]:[\\/]/.test(value) || /^(?:\\\\\?\\)?[Zz]:[\\/]/.test(value);
}

function driveLetter(value: string): string {
  const match = /^(?:\\\\\?\\)?([A-Za-z]):/.exec(value);
  return match ? match[1]!.toUpperCase() : "";
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}
