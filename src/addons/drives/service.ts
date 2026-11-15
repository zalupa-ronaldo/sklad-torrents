import { summarizeIndexed } from "@/addons/drives/disk-summary";
import { pollAgents } from "@/addons/drives/agent-client";
import { scheduleIndexIngest } from "@/addons/drives/shelf-ingest";
import { applyIndexUpdate } from "@/addons/drives/index-apply";
import { loadLibraries } from "@/addons/drives/libraries";
import { buildMockCatalog, liveObservations } from "@/addons/drives/mock-source";
import { detachUnreachableHosts, mountPathsOf, online, reconcileCatalog } from "@/addons/drives/reconcile";
import { searchDisks } from "@/addons/drives/search";
import { readAgentConfig, readCatalog, writeCatalog, writeCatalogChanges, cacheCatalog, setLiveDisks, liveDisks, catalogNeedsMigrate, persistLargeCatalog, attachShardStats, shardIsCurrent, ensureCleanCatalog, type CatalogFile } from "@/addons/drives/store";
import { uniqueDisks } from "@/addons/drives/disk-table";
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

function summaryOf(disk: DiskRecord): { summary: NonNullable<DiskRecord["summary"]>; partial: boolean; sizesKnown: boolean } {
  const reported = disk.reportedRecords ?? 0;
  if (disk.summary) {
    const emptyClaim = reported > 0 && disk.summary.fileCount === 0 && disk.files.length === 0 && !disk.fileStore;
    if (emptyClaim) {
      return {
        summary: { ...disk.summary, fileCount: reported, indexedBytes: 0 },
        partial: true,
        sizesKnown: false,
      };
    }
    const unknown = disk.summary.unknownSizes ?? 0;
    return { summary: disk.summary, partial: false, sizesKnown: unknown === 0 || disk.summary.indexedBytes > 0 };
  }
  const cached = summaryCache.get(disk.files);
  if (cached) return { summary: cached, partial: false, sizesKnown: (cached.unknownSizes ?? 0) === 0 || cached.indexedBytes > 0 };
  // The file list is not in memory yet, or it is too large to total inside this request.
  if ((disk.files.length === 0 && reported > 0) || disk.files.length > 50_000 || disk.pendingRevision) {
    return {
      summary: {
        fileCount: reported || disk.files.length,
        indexedBytes: 0,
        categoryCounts: { torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 },
      },
      partial: true,
      sizesKnown: false,
    };
  }
  const summary = summarizeIndexed(disk.files);
  disk.summary = summary;
  summaryCache.set(disk.files, summary);
  return { summary, partial: false, sizesKnown: (summary.unknownSizes ?? 0) === 0 || summary.indexedBytes > 0 };
}

export function toView(disks: readonly DiskRecord[]): DiskView[] {
  const byId = new Map(disks.map((disk) => [disk.id, disk]));
  return disks.map((disk) => {
    const { summary, partial, sizesKnown } = summaryOf(disk);
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
      sizesKnown: sizesKnown && !partial,
      ingest: disk.ingest,
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

let shelfFlight: Promise<ShelfResponse> | null = null;

export function getShelf(): Promise<ShelfResponse> {
  if (!shelfFlight) {
    shelfFlight = loadShelf().finally(() => {
      shelfFlight = null;
    });
  }
  return shelfFlight;
}

async function loadShelf(): Promise<ShelfResponse> {
  await ensureCleanCatalog();
  return withLock(async () => {
    const config = await readAgentConfig();
    const libraries = await loadLibraries();
    const remembered = liveDisks();
    const heavy = config.mode === "agents" && !remembered && (await catalogNeedsMigrate());
    if (heavy) startLegacyCatalogMigrate();
    const stored = remembered
      ? { version: 1 as const, seeded: true, disks: remembered }
      : heavy
        ? { version: 1 as const, seeded: true, disks: [] as DiskRecord[] }
        : await readCatalog();
    if (stored) await attachShardStats(stored.disks);
    const now = new Date().toISOString();
    if (config.mode === "mock") {
      const base = stored?.seeded ? stored.disks : buildMockCatalog(libraries);
      const disks = reconcileCatalog(base, liveObservations(), libraries, now);
      await save(disks, true);
      return present(disks, "mock", []);
    }
    const { observations, errors, deferred } = await pollAgents(config.agents, liveDisks() ?? stored?.disks ?? []);
    const base = liveDisks() ?? stored?.disks ?? [];
    const reconciled = reconcileCatalog(base, observations, libraries, now);
    const disks = detachUnreachableHosts(
      reconciled,
      errors.flatMap((error) => {
        const agent = config.agents.find((item) => item.id === error.hostId);
        return agent ? [{ id: agent.id, name: agent.name, os: agent.os }] : [];
      }),
      config.agents,
    );
    const unique = uniqueDisks(disks);
    setLiveDisks(unique);
    if (deferred.length > 0) scheduleIndexIngest(deferred, libraries);
    const changed = !stored || unique.length !== stored.disks.length || unique.some((disk) => {
      const before = stored.disks.find((item) => item.id === disk.id);
      if (!before) return true;
      if (before.indexRevision !== disk.indexRevision || before.fileStore !== disk.fileStore || before.shardRevision !== disk.shardRevision) return true;
      if (before.label !== disk.label || before.connectedHosts.length !== disk.connectedHosts.length) return true;
      if (before.files === disk.files || shardIsCurrent(disk)) return false;
      return true;
    });
    const large = unique.some((disk) => disk.files.length > 20_000 || Boolean(disk.fileStore));
    if (!heavy && changed && !large) await writeCatalogChanges({ version: 1, seeded: true, disks: unique }, stored);
    else if (!heavy && changed && large) void persistLargeCatalog(unique).catch(() => undefined);
    else if (!heavy) cacheCatalog({ version: 1, seeded: true, disks: unique });
    return present(unique, "agents", errors);
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

export async function renameDisk(id: string, label: string, reset = false): Promise<DiskView> {
  const next = label.trim();
  if (!reset) {
    if (!next) throw new DriveError(400, "Укажите имя или сбросьте псевдоним.");
    if (next.length > 80) throw new DriveError(400, "Имя длиннее 80 символов.");
    if (/[\u0000-\u001f<>]/.test(next)) throw new DriveError(400, "Имя содержит недопустимые символы.");
  }
  return withLock(async () => {
    const config = await readAgentConfig();
    const libraries = await loadLibraries();
    const live = liveDisks();
    const stored = live ? null : await readCatalog();
    const base = live ?? stored?.disks ?? (config.mode === "mock" ? buildMockCatalog(libraries) : []);
    const disk = base.find((item) => item.id === id);
    if (!disk) throw new DriveError(404, "Диск на полке не найден.");
    if (reset) {
      disk.label = disk.volumeName || "Без имени";
      disk.namedByUser = false;
    } else {
      disk.label = next;
      disk.namedByUser = true;
    }
    if (base.some((item) => item.files.length > 20_000 || item.fileStore)) await persistLargeCatalog(base);
    else await save(base, true);
    return toView(liveDisks() ?? base).find((item) => item.id === id)!;
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
