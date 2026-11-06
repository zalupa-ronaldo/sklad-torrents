import { summarizeIndexed } from "@/addons/drives/disk-summary";
import { pollAgents } from "@/addons/drives/agent-client";
import { scheduleIndexIngest } from "@/addons/drives/shelf-ingest";
import { applyIndexUpdate } from "@/addons/drives/index-apply";
import { loadLibraries } from "@/addons/drives/libraries";
import { buildMockCatalog, liveObservations } from "@/addons/drives/mock-source";
import { mountPathsOf, online, reconcileCatalog } from "@/addons/drives/reconcile";
import { searchDisks } from "@/addons/drives/search";
import { readAgentConfig, readCatalog, writeCatalog, writeCatalogChanges, cacheCatalog, setLiveDisks, liveDisks, catalogFileBytes, HEAVY_CATALOG_BYTES, persistLargeCatalog, type CatalogFile } from "@/addons/drives/store";
import { startLegacyCatalogMigrate } from "@/addons/drives/catalog-migrate";
import type { DiskRecord, DiskView, DriveMode, HostObservation, SearchResponse, ShelfResponse } from "@/addons/drives/types";
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

const summaryCache = new WeakMap<DiskRecord["files"], DiskRecord["summary"] & object>();

function summaryOf(disk: DiskRecord): { summary: NonNullable<DiskRecord["summary"]>; partial: boolean } {
  if (disk.summary) return { summary: disk.summary, partial: false };
  const cached = summaryCache.get(disk.files);
  if (cached) return { summary: cached, partial: false };
  const reported = disk.reportedRecords ?? 0;
  // The file list is not in memory yet, or it is too large to total inside this request.
  if ((disk.files.length === 0 && reported > 0) || disk.files.length > 50_000 || disk.pendingRevision) {
    return {
      summary: {
        fileCount: reported || disk.files.length,
        indexedBytes: 0,
        categoryCounts: { torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 },
      },
      partial: true,
    };
  }
  const summary = summarizeIndexed(disk.files);
  disk.summary = summary;
  summaryCache.set(disk.files, summary);
  return { summary, partial: false };
}

export function toView(disks: readonly DiskRecord[]): DiskView[] {
  const byId = new Map(disks.map((disk) => [disk.id, disk]));
  return disks.map((disk) => {
    const { summary, partial } = summaryOf(disk);
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
      categoryCounts: summary.categoryCounts,
      fileCount: partial ? (disk.reportedRecords || summary.fileCount) : summary.fileCount,
      indexedBytes: summary.indexedBytes,
      sizesReady: !partial,
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
    const remembered = liveDisks();
    const heavy = config.mode === "agents" && !remembered && (await catalogFileBytes()) > HEAVY_CATALOG_BYTES;
    if (heavy) startLegacyCatalogMigrate();
    const stored = remembered
      ? { version: 1 as const, seeded: true, disks: remembered }
      : heavy
        ? { version: 1 as const, seeded: true, disks: [] as DiskRecord[] }
        : await readCatalog();
    const now = new Date().toISOString();
    if (config.mode === "mock") {
      const base = stored?.seeded ? stored.disks : buildMockCatalog(libraries);
      const disks = reconcileCatalog(base, liveObservations(), libraries, now);
      await save(disks, true);
      return present(disks, "mock", []);
    }
    const { observations, errors, deferred } = await pollAgents(config.agents, stored?.disks ?? []);
    const disks = reconcileCatalog(stored?.disks ?? [], observations, libraries, now);
    setLiveDisks(disks);
    if (deferred.length > 0) scheduleIndexIngest(deferred, libraries);
    const changed = !stored || disks.length !== stored.disks.length || disks.some((disk) => {
      const before = stored.disks.find((item) => item.id === disk.id);
      return !before || before.files !== disk.files;
    });
    const large = disks.some((disk) => disk.files.length > 20_000 || Boolean(disk.fileStore));
    if (!heavy && changed && !large) await writeCatalogChanges({ version: 1, seeded: true, disks }, stored);
    else if (!heavy && changed && large) void persistLargeCatalog(disks);
    else if (!heavy) cacheCatalog({ version: 1, seeded: true, disks });
    return present(disks, "agents", errors);
  });
}

async function disksForRead(): Promise<DiskRecord[]> {
  const live = liveDisks();
  if (live) return live;
  const stored = await readCatalog();
  if (stored) {
    setLiveDisks(stored.disks);
    return stored.disks;
  }
  await getShelf();
  return liveDisks() ?? [];
}

export async function searchShelf(query: string, limit = 100): Promise<SearchResponse> {
  // Search the ready local tree: never queue behind an agent poll or disk scan.
  const disks = await disksForRead();
  const { ensureDiskFiles } = await import("@/addons/drives/store");
  for (const disk of disks) await ensureDiskFiles(disk);
  return { query, hits: searchDisks(disks, query, Math.min(1000, Math.max(1, Math.floor(limit) || 100))) };
}

export async function browseShelf(diskId: string | null, relativePath = "", cursor = 0, limit = 200) {
  const disks = await disksForRead();
  if (diskId) {
    const disk = disks.find((item) => item.id === diskId);
    if (disk) {
      const { ensureDiskFiles } = await import("@/addons/drives/store");
      await ensureDiskFiles(disk);
    }
  }
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
