import { createHash } from "node:crypto";

import { coverFor } from "@/lib/windows-library/covers";
import type { CatalogFile, CompressionState, CoverCacheEntry, IndexedEntry, LauncherKind, VolumeCursor, WinGame } from "@/lib/windows-library/types";
import { volumeKey } from "@/lib/windows-library/volume-policy";

const FOLDER = /^(games|игры|steamlibrary|epic games|gog games)$/i;

export interface VolumeSlice {
  cursor: VolumeCursor;
  entries: readonly IndexedEntry[];
  texts: readonly CatalogFile[];
}

/** Build the game list from an index that already exists. This does not walk a disk. */
export function buildGames(slices: readonly VolumeSlice[], covers: Readonly<Record<string, CoverCacheEntry>>): WinGame[] {
  const games: WinGame[] = [];
  const claimed = new Set<string>();
  for (const slice of slices) {
    for (const text of slice.texts) {
      if (volumeKey(slice.cursor) !== text.volumeKey) continue;
      if (!entryExists(slice.entries, text.relativePath)) continue;
      const steam = readSteam(text.text);
      if (steam && /appmanifest_\d+\.acf$/i.test(text.relativePath)) {
        const game = steamGame(slice, text.relativePath, steam, covers);
        if (game) {
          games.push(game);
          claimed.add(claimKey(game.serial, game.uuid, game.root));
        }
      }
    }
  }
  for (const slice of slices) {
    for (const text of slice.texts) {
      if (volumeKey(slice.cursor) !== text.volumeKey) continue;
      if (!entryExists(slice.entries, text.relativePath)) continue;
      const epic = readEpic(text.text, text.relativePath);
      if (epic) {
        const located = locate(slices, epic.installLocation) ?? slice;
        const game = placed(located, epic.installLocation, epic.title, "epic", null, text, covers, slice);
        if (game && !claimed.has(claimKey(game.serial, game.uuid, game.root))) {
          games.push(game);
          claimed.add(claimKey(game.serial, game.uuid, game.root));
        }
      }
      const gog = readGog(text.text, text.relativePath);
      if (gog) {
        const root = absolute(slice.cursor, parentRelative(text.relativePath));
        const game = placed(slice, root, gog.title, "gog", null, text, covers, slice);
        if (game && !claimed.has(claimKey(game.serial, game.uuid, game.root))) {
          games.push(game);
          claimed.add(claimKey(game.serial, game.uuid, game.root));
        }
      }
    }
    for (const folder of folderGames(slice)) {
      if (claimed.has(claimKey(slice.cursor.serial, slice.cursor.uuid, folder.root))) continue;
      const measured = measure(slice.entries, folder.relative);
      games.push(record({
        cursor: slice.cursor,
        title: folder.title,
        launcher: "folder",
        steamAppId: null,
        root: folder.root,
        installdir: null,
        manifestPath: null,
        libraryFoldersPath: null,
        measured,
        covers,
      }));
    }
  }
  return games;
}

function steamGame(slice: VolumeSlice, manifestRelative: string, steam: { appId: number; title: string; installdir: string }, covers: Readonly<Record<string, CoverCacheEntry>>): WinGame | null {
  const libraryRelative = steamLibraryRelative(manifestRelative);
  if (libraryRelative == null) return null;
  const gameRelative = `${libraryRelative ? `${libraryRelative}/` : ""}steamapps/common/${steam.installdir}`.replace(/^\//, "");
  const root = absolute(slice.cursor, gameRelative);
  const measured = measure(slice.entries, gameRelative);
  return record({
    cursor: slice.cursor,
    title: steam.title,
    launcher: "steam",
    steamAppId: steam.appId,
    root,
    installdir: steam.installdir,
    manifestPath: absolute(slice.cursor, manifestRelative),
    libraryFoldersPath: libraryFolders(slice, libraryRelative),
    measured,
    covers,
  });
}

function placed(
  slice: VolumeSlice,
  root: string,
  title: string,
  launcher: LauncherKind,
  steamAppId: number | null,
  text: CatalogFile,
  covers: Readonly<Record<string, CoverCacheEntry>>,
  manifestSlice: VolumeSlice,
): WinGame | null {
  const relative = relativeTo(slice.cursor, root);
  if (relative == null) return null;
  return record({
    cursor: slice.cursor,
    title,
    launcher,
    steamAppId,
    root: absolute(slice.cursor, relative),
    installdir: null,
    manifestPath: absolute(manifestSlice.cursor, text.relativePath),
    libraryFoldersPath: null,
    measured: measure(slice.entries, relative),
    covers,
  });
}

function record(input: {
  cursor: VolumeCursor;
  title: string;
  launcher: LauncherKind;
  steamAppId: number | null;
  root: string;
  installdir: string | null;
  manifestPath: string | null;
  libraryFoldersPath: string | null;
  measured: { logicalBytes: number | null; allocatedBytes: number | null; compression: CompressionState; algorithm: string | null };
  covers: Readonly<Record<string, CoverCacheEntry>>;
}): WinGame {
  const id = gameIdentity(input.cursor.serial, input.cursor.uuid, input.launcher, input.steamAppId, input.root);
  return {
    id,
    title: input.title,
    launcher: input.launcher,
    steamAppId: input.steamAppId,
    root: input.root,
    installdir: input.installdir,
    manifestPath: input.manifestPath,
    libraryFoldersPath: input.libraryFoldersPath,
    serial: input.cursor.serial,
    uuid: input.cursor.uuid,
    archiveRoot: input.root,
    archiveSerial: input.cursor.serial,
    archiveUuid: input.cursor.uuid,
    logicalBytes: input.measured.logicalBytes,
    allocatedBytes: input.measured.allocatedBytes,
    compression: input.measured.compression,
    algorithm: input.measured.algorithm,
    cover: coverFor({ title: input.title, steamAppId: input.steamAppId }, input.covers),
    pool: "archive",
    online: input.cursor.attached,
  };
}

export function gameIdentity(serial: string, uuid: string, launcher: string, steamAppId: number | null, root: string): string {
  const digest = createHash("sha256").update(`${serial}|${uuid}|${launcher}|${steamAppId ?? ""}|${norm(root)}`).digest("hex").slice(0, 12);
  return `wg-${digest}`;
}

export function measure(entries: readonly IndexedEntry[], relativeRoot: string): { logicalBytes: number | null; allocatedBytes: number | null; compression: CompressionState; algorithm: string | null } {
  const prefix = relativeRoot.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const files = entries.filter((entry) => !entry.isDirectory && under(entry.relativePath, prefix));
  if (files.length === 0) return { logicalBytes: 0, allocatedBytes: 0, compression: "unknown", algorithm: null };
  const logical = files.some((file) => file.logicalBytes == null) ? null : files.reduce((sum, file) => sum + (file.logicalBytes ?? 0), 0);
  const allocated = files.some((file) => file.allocatedBytes == null) ? null : files.reduce((sum, file) => sum + (file.allocatedBytes ?? 0), 0);
  const flags = files.map((file) => file.compressed);
  if (flags.some((flag) => flag == null)) {
    return { logicalBytes: logical, allocatedBytes: allocated, compression: flags.some((flag) => flag === true) ? "mixed" : "unknown", algorithm: null };
  }
  if (flags.every((flag) => flag === false)) return { logicalBytes: logical, allocatedBytes: allocated, compression: "uncompressed", algorithm: null };
  if (flags.every((flag) => flag === true)) {
    const algorithms = new Set(files.map((file) => file.algorithm).filter((value): value is string => Boolean(value)));
    return { logicalBytes: logical, allocatedBytes: allocated, compression: "compressed", algorithm: algorithms.size === 1 ? [...algorithms][0]! : null };
  }
  return { logicalBytes: logical, allocatedBytes: allocated, compression: "mixed", algorithm: null };
}

function folderGames(slice: VolumeSlice): { title: string; root: string; relative: string }[] {
  const dirs = slice.entries.filter((entry) => entry.isDirectory);
  const found: { title: string; root: string; relative: string }[] = [];
  for (const dir of dirs) {
    const parts = dir.relativePath.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    if (!FOLDER.test(parts[parts.length - 2] ?? "")) continue;
    if (parts.some((part) => part.toLowerCase() === "steamapps")) continue;
    const relative = parts.join("/");
    const exe = slice.entries.some((entry) => !entry.isDirectory && under(entry.relativePath, relative) && /\.exe$/i.test(entry.name) && !/crashhandler|unitycrash/i.test(entry.name));
    if (!exe) continue;
    found.push({ title: parts[parts.length - 1]!, root: absolute(slice.cursor, relative), relative });
  }
  return found;
}

function readSteam(text: string): { appId: number; title: string; installdir: string } | null {
  const appId = Number(/"appid"\s+"(\d+)"/i.exec(text)?.[1]);
  const title = /"name"\s+"([^"]+)"/i.exec(text)?.[1]?.trim() ?? "";
  const installdir = /"installdir"\s+"([^"]+)"/i.exec(text)?.[1]?.trim() ?? "";
  if (!title || !installdir || !Number.isInteger(appId)) return null;
  return { appId, title, installdir };
}

function readEpic(text: string, relativePath: string): { title: string; installLocation: string } | null {
  if (!/manifests\/.+\.item$/i.test(relativePath) && !/manifest_.*\.json$/i.test(relativePath)) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const title = typeof parsed.DisplayName === "string" ? parsed.DisplayName.trim() : "";
    const installLocation = typeof parsed.InstallLocation === "string" ? parsed.InstallLocation.trim() : "";
    if (!title || !installLocation) return null;
    return { title, installLocation };
  } catch {
    return null;
  }
}

function readGog(text: string, relativePath: string): { title: string } | null {
  if (!/goggame-.*\.info$/i.test(relativePath)) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const title = typeof parsed.name === "string" ? parsed.name.trim() : "";
    return title ? { title } : null;
  } catch {
    return null;
  }
}

function libraryFolders(slice: VolumeSlice, libraryRelative: string): string | null {
  const folder = libraryRelative ? `${libraryRelative}/` : "";
  const found = slice.entries.find((entry) => !entry.isDirectory && entry.relativePath.toLowerCase() === `${folder}steamapps/libraryfolders.vdf`.toLowerCase())
    ?? slice.entries.find((entry) => !entry.isDirectory && entry.relativePath.toLowerCase() === `${folder}config/libraryfolders.vdf`.toLowerCase());
  return found ? absolute(slice.cursor, found.relativePath) : null;
}

function steamLibraryRelative(manifestRelative: string): string | null {
  const parts = manifestRelative.replace(/\\/g, "/").split("/");
  const index = parts.findIndex((part) => part.toLowerCase() === "steamapps");
  if (index < 0) return null;
  return parts.slice(0, index).join("/");
}

function locate(slices: readonly VolumeSlice[], fullPath: string): VolumeSlice | null {
  const target = norm(fullPath);
  let best: VolumeSlice | null = null;
  let bestLength = -1;
  for (const slice of slices) {
    const mount = norm(mountOf(slice.cursor));
    if (!mount) continue;
    if (target === mount || target.startsWith(`${mount}/`)) {
      if (mount.length > bestLength) {
        best = slice;
        bestLength = mount.length;
      }
    }
  }
  return best;
}

function relativeTo(cursor: VolumeCursor, fullPath: string): string | null {
  const mount = norm(mountOf(cursor));
  const target = norm(fullPath);
  if (!mount || (target !== mount && !target.startsWith(`${mount}/`))) return null;
  return target.slice(mount.length).replace(/^\/+/, "");
}

function absolute(cursor: VolumeCursor, relative: string): string {
  const mount = mountOf(cursor).replace(/[\\/]+$/, "");
  const separator = cursor.os === "win32" || mount.includes("\\") ? "\\" : "/";
  return `${mount}${separator}${relative.replace(/\//g, separator)}`;
}

function mountOf(cursor: VolumeCursor): string {
  if (cursor.mount) return cursor.mount;
  if (cursor.letter) return `${cursor.letter}:\\`;
  return "";
}

function parentRelative(relative: string): string {
  const parts = relative.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
}

function entryExists(entries: readonly IndexedEntry[], relative: string): boolean {
  const target = relative.replace(/\\/g, "/").toLowerCase();
  return entries.some((entry) => entry.relativePath.replace(/\\/g, "/").toLowerCase() === target);
}

function under(relative: string, root: string): boolean {
  const path = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const prefix = root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return path === prefix || path.startsWith(`${prefix}/`);
}

function claimKey(serial: string, uuid: string, root: string): string {
  return `${serial}|${uuid}|${norm(root)}`;
}

function norm(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
