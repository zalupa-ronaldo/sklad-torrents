import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { appDataDir } from "@/lib/app-data";
import {
  isPathUnder,
  resolveFilesystem,
  type FilesystemKind,
  type OsKind,
} from "@/lib/drive/filesystem";
import { dryRunPolicy, type PolicyDecision } from "@/lib/drive/policy";

export interface DiskRecord {
  id: string;
  label: string;
  hostId: string;
  hostName: string;
  os: OsKind;
  filesystem: FilesystemKind;
  mount: string;
  /** Directory on this machine that mirrors `mount`, when the disk is actually here. */
  localRoot: string | null;
}

export interface CatalogEntry {
  id: string;
  kind: "file" | "folder";
  name: string;
  path: string;
  localPath: string | null;
  diskId: string;
  hostId: string;
  size: number;
  os: OsKind;
  filesystem: FilesystemKind;
  source: "catalog" | "localsend";
  policy: PolicyDecision | null;
}

export interface ReceivedFileInput {
  fileName: string;
  size: number;
  savedPath: string;
  catalogPath: string;
  os: OsKind;
  filesystem: FilesystemKind | null;
  diskId: string | null;
  hostId: string | null;
}

interface IndexFile {
  files: CatalogEntry[];
}

const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "localsend");

function demoDisks(): DiskRecord[] {
  return [
    {
      id: "disk-local",
      label: "Эта машина",
      hostId: "local",
      hostName: "Склад",
      os: "linux",
      filesystem: "other",
      mount: FIXTURE_DIR,
      localRoot: FIXTURE_DIR,
    },
    {
      id: "disk-mac",
      label: "Mac vault",
      hostId: "demo-mac",
      hostName: "Mac mini",
      os: "darwin",
      filesystem: "apfs",
      mount: "/Volumes/vault",
      localRoot: null,
    },
    {
      id: "disk-win",
      label: "Windows D",
      hostId: "demo-win",
      hostName: "Windows PC",
      os: "win32",
      filesystem: "ntfs",
      mount: "D:\\",
      localRoot: null,
    },
  ];
}

function demoEntries(): CatalogEntry[] {
  const local = demoDisks()[0];
  const mac = demoDisks()[1];
  const win = demoDisks()[2];
  const folderPath = FIXTURE_DIR;
  return [
    {
      id: "folder-notes",
      kind: "folder",
      name: "Демо LocalSend",
      path: folderPath,
      localPath: folderPath,
      diskId: local.id,
      hostId: local.hostId,
      size: 0,
      os: local.os,
      filesystem: local.filesystem,
      source: "catalog",
      policy: null,
    },
    fileEntry(local, "fixture-note", "sklad-note.txt", path.join(FIXTURE_DIR, "sklad-note.txt"), 0),
    fileEntry(local, "fixture-clip", "sklad-clip.bin", path.join(FIXTURE_DIR, "sklad-clip.bin"), 0),
    fileEntry(mac, "mac-movie", "Cinema/Interstellar.2014.2160p.mkv", "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv", 1_000_000_000),
    fileEntry(win, "win-game", "Games\\Control\\data.pack", "D:\\Games\\Control\\data.pack", 2_000_000_000),
  ];
}

function fileEntry(disk: DiskRecord, id: string, name: string, fullPath: string, size: number): CatalogEntry {
  const local = disk.localRoot && fullPath.startsWith(disk.localRoot) ? fullPath : disk.localRoot ? null : null;
  const readable = disk.localRoot != null && (fullPath === disk.localRoot || fullPath.startsWith(disk.localRoot + path.sep) || fullPath.startsWith(disk.localRoot + "/"));
  return {
    id,
    kind: "file",
    name: name.split(/[/\\]/).pop() || name,
    path: fullPath,
    localPath: readable ? fullPath : local,
    diskId: disk.id,
    hostId: disk.hostId,
    size,
    os: disk.os,
    filesystem: resolveFilesystem({ os: disk.os, path: fullPath, filesystem: disk.filesystem }),
    source: "catalog",
    policy: null,
  };
}

export function listDisks(): DiskRecord[] {
  return demoDisks();
}

export function getDisk(id: string): DiskRecord | null {
  return demoDisks().find((disk) => disk.id === id) ?? null;
}

export async function listEntries(): Promise<CatalogEntry[]> {
  const stored = await readStored();
  const demo = demoEntries();
  const storedPaths = new Set(stored.map((entry) => entry.path));
  const merged = [...demo.filter((entry) => !storedPaths.has(entry.path)), ...stored];
  for (const entry of merged) {
    if (entry.kind !== "file" || !entry.localPath) continue;
    try {
      entry.size = (await stat(entry.localPath)).size;
    } catch {
      entry.localPath = null;
    }
  }
  return merged;
}

export async function searchCatalog(query: string): Promise<CatalogEntry[]> {
  const all = await listEntries();
  const needle = query.trim().toLowerCase();
  if (!needle) return all;
  const disks = new Map(listDisks().map((disk) => [disk.id, disk]));
  return all.filter((entry) => {
    const disk = disks.get(entry.diskId);
    return [entry.name, entry.path, entry.filesystem, disk?.label, disk?.hostName]
      .join("\n")
      .toLowerCase()
      .includes(needle);
  });
}

export async function entriesByIds(ids: string[]): Promise<CatalogEntry[]> {
  const wanted = new Set(ids);
  const all = await listEntries();
  return all.filter((entry) => wanted.has(entry.id));
}

export async function expandSelection(ids: string[]): Promise<CatalogEntry[]> {
  const all = await listEntries();
  const selected = all.filter((entry) => ids.includes(entry.id));
  const files: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const entry of selected) {
    const group = entry.kind === "folder" ? all.filter((item) => item.kind === "file" && isPathUnder(entry.os, entry.path, item.path)) : [entry];
    for (const file of group) {
      if (file.kind !== "file" || seen.has(file.path)) continue;
      seen.add(file.path);
      files.push(file);
    }
  }
  return files;
}

/**
 * Incremental, read-only index update. Runs classification and a dry-run policy.
 * Does not delete, move, or enable a destructive action.
 */
export async function acceptReceivedFiles(files: ReceivedFileInput[]): Promise<CatalogEntry[]> {
  if (files.length === 0) return [];
  const stored = await readStored();
  const saved: CatalogEntry[] = [];
  for (const file of files) {
    const filesystem = resolveFilesystem({
      os: file.os,
      path: file.catalogPath,
      filesystem: file.filesystem,
    });
    if (filesystem === "ntfs" && (file.os === "darwin" || file.catalogPath.startsWith("/Volumes/"))) {
      throw new Error("Путь APFS нельзя записать в каталог как NTFS.");
    }
    const policy = dryRunPolicy({ name: file.fileName, path: file.catalogPath });
    if (policy.destructive || policy.action !== "none") {
      throw new Error("Политика приёма не должна удалять или переносить файлы.");
    }
    const entry: CatalogEntry = {
      id: `ls-${randomUUID()}`,
      kind: "file",
      name: file.fileName.split(/[/\\]/).pop() || file.fileName,
      path: file.catalogPath,
      localPath: file.savedPath,
      diskId: file.diskId ?? "disk-local",
      hostId: file.hostId ?? "local",
      size: file.size,
      os: file.os,
      filesystem,
      source: "localsend",
      policy,
    };
    const index = stored.findIndex((item) => item.path === entry.path);
    if (index >= 0) stored[index] = { ...entry, id: stored[index].id };
    else stored.push(entry);
    saved.push(index >= 0 ? stored[index] : entry);
  }
  await writeStored(stored);
  return saved;
}

function indexPath(): string {
  return path.join(appDataDir(), "drive-index.json");
}

async function readStored(): Promise<CatalogEntry[]> {
  try {
    const text = await readFile(indexPath(), "utf8");
    const parsed = JSON.parse(text) as IndexFile;
    if (!parsed || !Array.isArray(parsed.files)) return [];
    return parsed.files.filter((entry) => entry && typeof entry.path === "string" && typeof entry.id === "string");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeStored(files: CatalogEntry[]): Promise<void> {
  const file = indexPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ files } satisfies IndexFile, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
