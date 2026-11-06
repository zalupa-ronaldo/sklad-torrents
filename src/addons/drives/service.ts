import { pollAgents } from "@/addons/drives/agent-client";
import { applyIndexUpdate } from "@/addons/drives/index-apply";
import { loadLibraries } from "@/addons/drives/libraries";
import { buildMockCatalog, liveObservations } from "@/addons/drives/mock-source";
import { fileCount, mountPathsOf, online, reconcileCatalog } from "@/addons/drives/reconcile";
import { searchDisks } from "@/addons/drives/search";
import { readAgentConfig, readCatalog, writeCatalog, writeCatalogChanges, cacheCatalog, type CatalogFile } from "@/addons/drives/store";
import type { DiskRecord, DiskView, DriveMode, HostObservation, MediaCategory, SearchResponse, ShelfResponse } from "@/addons/drives/types";
import { DriveError } from "@/addons/drives/types";

let chain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const summaryCache = new WeakMap<DiskRecord["files"], { tally: Record<MediaCategory, number>; files: number; bytes: number }>();
function summaryOf(disk: DiskRecord): { tally: Record<MediaCategory, number>; files: number; bytes: number } {
  const cached = summaryCache.get(disk.files);
  if (cached) return cached;
  const tally = { torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 };
  let bytes = 0;
  for (const file of disk.files) {
    if (file.kind !== "file" || file.name === "sklad-catalog.json") continue;
    if (file.size > 0) bytes += file.size;
    for (const category of file.categories) tally[category] += 1;
  }
  const summary = { tally, files: fileCount(disk.files), bytes };
  summaryCache.set(disk.files, summary);
  return summary;
}

export function toView(disks: readonly DiskRecord[]): DiskView[] {
  const byId = new Map(disks.map((disk) => [disk.id, disk]));
  return disks.map((disk) => {
    const summary = summaryOf(disk);
    return {
      id: disk.id,
      label: disk.label,
      namedByUser: disk.namedByUser,
      volumeName: disk.volumeName,
      serial: disk.serial,
      volumeUuid: disk.volumeUuid,
      filesystem: disk.filesystem,
      totalBytes: disk.totalBytes,
      freeBytes: disk.freeBytes,
      online: online(disk),
      lastSeenAt: disk.lastSeenAt,
      lastHostId: disk.lastHostId,
      lastHostName: disk.lastHostName,
      mountPaths: mountPathsOf(disk),
      lastMountPath: disk.lastMountPath,
      priorMountPath: disk.priorMountPath,
      duplicateMounts: disk.duplicateMounts,
      possibleClone: disk.possibleClone,
      clonePeerLabels: disk.cloneOfIds.map((id) => byId.get(id)?.label).filter((label): label is string => Boolean(label)),
      scan: disk.scan,
      categoryCounts: summary.tally,
      fileCount: summary.files,
      indexedBytes: summary.bytes,
    };
  });
}

function present(disks: DiskRecord[], mode: DriveMode, agentErrors: ShelfResponse["agentErrors"]): ShelfResponse {
  const views = toView(disks).sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label, "ru"));
  return { mode, readOnly: true, disks: views, agentErrors };
}

async function save(disks: DiskRecord[], seeded: boolean): Promise<void> {
  const file: CatalogFile = { version: 1, seeded, disks };
  await writeCatalog(file);
}

export async function getShelf(): Promise<ShelfResponse> {
  return withLock(async () => {
    const config = await readAgentConfig();
    const libraries = await loadLibraries();
    const stored = await readCatalog();
    const now = new Date().toISOString();
    if (config.mode === "mock") {
      const base = stored?.seeded ? stored.disks : buildMockCatalog(libraries);
      const disks = reconcileCatalog(base, liveObservations(), libraries, now);
      await save(disks, true);
      return present(disks, "mock", []);
    }
    const { observations, errors } = await pollAgents(config.agents, stored?.disks ?? []);
    const disks = reconcileCatalog(stored?.disks ?? [], observations, libraries, now);
    const changed = !stored || disks.length !== stored.disks.length || disks.some((disk) => {
      const before = stored.disks.find((item) => item.id === disk.id);
      return !before || before.files !== disk.files;
    });
    if (changed) await writeCatalogChanges({ version: 1, seeded: true, disks }, stored);
    else cacheCatalog({ version: 1, seeded: true, disks });
    return present(disks, "agents", errors);
  });
}

export async function searchShelf(query: string, limit = 100): Promise<SearchResponse> {
  // Search the ready local tree: never queue behind an agent poll or disk scan.
  let stored = await readCatalog();
  if (!stored) { await getShelf(); stored = await readCatalog(); }
  return { query, hits: searchDisks(stored?.disks ?? [], query, Math.min(1000, Math.max(1, Math.floor(limit) || 100))) };
}

export async function browseShelf(diskId: string | null, relativePath = "", cursor = 0, limit = 200) {
  let stored = await readCatalog();
  if (!stored) {
    await getShelf();
    stored = await readCatalog();
  }
  const disks = stored?.disks ?? [];
  const { browseDisk, browseRoots } = await import("@/addons/drives/browse");
  if (!diskId) return browseRoots(disks, limit, cursor);
  return browseDisk(disks, diskId, relativePath, limit, cursor);
}

export async function renameDisk(id: string, label: string): Promise<DiskView> {
  const next = label.trim();
  if (!next) throw new DriveError(400, "Укажите имя диска.");
  if (next.length > 80) throw new DriveError(400, "Имя диска длиннее 80 символов.");
  return withLock(async () => {
    const config = await readAgentConfig();
    const libraries = await loadLibraries();
    const stored = await readCatalog();
    const base = stored?.disks ?? (config.mode === "mock" ? buildMockCatalog(libraries) : []);
    const disk = base.find((item) => item.id === id);
    if (!disk) throw new DriveError(404, "Диск на полке не найден.");
    disk.label = next;
    disk.namedByUser = true;
    await save(base, true);
    return toView(base).find((item) => item.id === id)!;
  });
}

/**
 * Incremental catalog add. Does not format, move, or delete existing files.
 * A Mac APFS path is never attached to an NTFS disk.
 */
export async function appendReceivedFiles(input: {
  diskId: string | null;
  relativePath: string;
  size: number;
  os: "darwin" | "win32" | "linux";
  catalogPath: string;
}): Promise<void> {
  await withLock(async () => {
    const libraries = await loadLibraries();
    const config = await readAgentConfig();
    const stored = await readCatalog();
    const disks = stored?.disks ?? (config.mode === "mock" ? buildMockCatalog(libraries) : []);
    const apfsPath = input.os === "darwin" || input.catalogPath.startsWith("/Volumes/");
    let disk = input.diskId ? disks.find((item) => item.id === input.diskId) : undefined;
    if (apfsPath) {
      if (disk && disk.filesystem.toLowerCase() === "ntfs") {
        throw new DriveError(400, "Путь APFS нельзя записать в каталог как NTFS.");
      }
      disk = disk && disk.filesystem.toLowerCase() !== "ntfs" ? disk : disks.find((item) => item.filesystem.toLowerCase() === "apfs");
    }
    if (!disk) return;
    if (apfsPath && disk.filesystem.toLowerCase() === "ntfs") {
      throw new DriveError(400, "Путь APFS нельзя записать в каталог как NTFS.");
    }
    const relativePath = input.relativePath.replace(/^[/\\]+/, "");
    const name = relativePath.split(/[/\\]/).pop() || relativePath;
    const mount = disk.lastMountPath || disk.connectedHosts[0]?.mountPaths[0] || "/";
    const updated = applyIndexUpdate({
      previous: disk.files,
      previousScan: disk.scan,
      update: {
        state: "complete",
        progress: 1,
        strategy: "walk",
        delta: {
          upserts: [{ relativePath, name, kind: "file", size: input.size, mtimeMs: Date.now() }],
          deletes: [],
          complete: true,
        },
      },
      busy: false,
      libraries,
      pathStyle: disk.pathStyle,
      mountPath: mount,
      filesystem: disk.filesystem,
      platform: disk.pathStyle === "win32" ? "win32" : "darwin",
      elevated: false,
    });
    disk.files = updated.files;
    disk.scan = { ...updated.scan, message: "LocalSend добавил файл в индекс. Диск не форматировался и файлы не переносились." };
    await save(disks, true);
  });
}

export async function ingestObservation(observation: HostObservation): Promise<ShelfResponse> {
  const config = await readAgentConfig();
  if (config.mode !== "mock") {
    throw new DriveError(400, "События демо принимаются только в демо-режиме.");
  }
  return withLock(async () => {
    const libraries = await loadLibraries();
    const stored = await readCatalog();
    const base = stored?.seeded ? stored.disks : buildMockCatalog(libraries);
    const now = new Date().toISOString();
    const disks = reconcileCatalog(base, [observation], libraries, now);
    await save(disks, true);
    return present(disks, "mock", []);
  });
}
