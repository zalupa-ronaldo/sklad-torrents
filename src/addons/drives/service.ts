import { pollAgents } from "@/addons/drives/agent-client";
import { loadLibraries } from "@/addons/drives/libraries";
import { buildMockCatalog, liveObservations } from "@/addons/drives/mock-source";
import { fileCount, mountPathsOf, online, reconcileCatalog } from "@/addons/drives/reconcile";
import { searchDisks } from "@/addons/drives/search";
import { readAgentConfig, readCatalog, writeCatalog, type CatalogFile } from "@/addons/drives/store";
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

function counts(disk: DiskRecord): Record<MediaCategory, number> {
  const tally = { torrent: 0, game: 0, media: 0 };
  for (const file of disk.files) {
    if (file.kind !== "file" || file.name === "sklad-catalog.json") continue;
    for (const category of file.categories) tally[category] += 1;
  }
  return tally;
}

export function toView(disks: readonly DiskRecord[]): DiskView[] {
  const byId = new Map(disks.map((disk) => [disk.id, disk]));
  return disks.map((disk) => ({
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
    fileCount: fileCount(disk.files),
    categoryCounts: counts(disk),
  }));
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
    const { observations, errors } = await pollAgents(config.agents);
    const disks = reconcileCatalog(stored?.disks ?? [], observations, libraries, now);
    await save(disks, true);
    return present(disks, "agents", errors);
  });
}

export async function searchShelf(query: string): Promise<SearchResponse> {
  const shelf = await getShelf();
  const stored = await readCatalog();
  return { query, hits: searchDisks(stored?.disks ?? [], query) };
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
