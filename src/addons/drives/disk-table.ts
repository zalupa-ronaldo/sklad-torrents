import type { ConnectedHost, DiskRecord } from "@/addons/drives/types";

/**
 * The catalog is a table keyed by disk id.
 * One id is one record. A later copy updates that record; it is never appended.
 * A Map is used so ids are not object prototype keys.
 */
export function diskTable(records: readonly DiskRecord[]): Map<string, DiskRecord> {
  const table = new Map<string, DiskRecord>();
  for (const disk of records) upsertDisk(table, disk);
  return table;
}

export function disksOf(table: ReadonlyMap<string, DiskRecord>): DiskRecord[] {
  return [...table.values()];
}

/** Collapse a legacy array. The same id keeps the richer index, shard, and alias. */
export function uniqueDisks(records: readonly DiskRecord[]): DiskRecord[] {
  return disksOf(diskTable(records));
}

export function upsertDisk(table: Map<string, DiskRecord>, incoming: DiskRecord): DiskRecord {
  const id = incoming.id;
  if (!id) return incoming;
  const current = table.get(id);
  const kept = current ? keepRicher(current, incoming) : sanitize(incoming);
  table.set(id, kept);
  return kept;
}

function sanitize(disk: DiskRecord): DiskRecord {
  disk.cloneOfIds = uniqueIds(disk.cloneOfIds, disk.id);
  disk.connectedHosts = uniqueHosts(disk.connectedHosts);
  return disk;
}

/**
 * Never replace a stored index, shard, or alias with an empty copy of the same id.
 * Different ids are not merged here, even when the label or capacity matches.
 */
function keepRicher(current: DiskRecord, incoming: DiskRecord): DiskRecord {
  const keeper = richness(current) >= richness(incoming) ? current : incoming;
  const other = keeper === current ? incoming : current;
  if (keeper.files.length === 0 && other.files.length > 0) keeper.files = other.files;
  if (!keeper.fileStore && other.fileStore) keeper.fileStore = other.fileStore;
  if ((keeper.shardBytes ?? 0) < (other.shardBytes ?? 0) && other.fileStore) {
    keeper.fileStore = other.fileStore;
    keeper.shardBytes = other.shardBytes;
  }
  if (!keeper.shardRevision && other.shardRevision) keeper.shardRevision = other.shardRevision;
  if ((keeper.shardBytes ?? 0) === 0 && (other.shardBytes ?? 0) > 0) keeper.shardBytes = other.shardBytes;
  if ((keeper.summary?.fileCount ?? 0) === 0 && (other.summary?.fileCount ?? 0) > 0) keeper.summary = other.summary;
  if ((keeper.reportedRecords ?? 0) < (other.reportedRecords ?? 0)) keeper.reportedRecords = other.reportedRecords;
  if (!keeper.indexRevision && other.indexRevision) keeper.indexRevision = other.indexRevision;
  if (other.namedByUser && !keeper.namedByUser) {
    keeper.label = other.label;
    keeper.namedByUser = true;
  }
  if (!keeper.serialNorm && other.serialNorm) {
    keeper.serial = other.serial;
    keeper.serialNorm = other.serialNorm;
  }
  keeper.connectedHosts = uniqueHosts([...keeper.connectedHosts, ...other.connectedHosts]);
  keeper.cloneOfIds = uniqueIds([...keeper.cloneOfIds, ...other.cloneOfIds], keeper.id);
  keeper.duplicateMounts = keeper.connectedHosts.some((host) => host.mountPaths.length > 1);
  return keeper;
}

function richness(disk: DiskRecord): number {
  const files = disk.files.length;
  const summary = disk.summary?.fileCount ?? 0;
  const shard = disk.fileStore && ((disk.shardBytes ?? 0) > 0 || summary > 0) ? Math.max(summary, disk.reportedRecords ?? 0, 1) : 0;
  return Math.max(files, shard);
}

function uniqueIds(ids: readonly string[], self: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || id === self || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function uniqueHosts(hosts: readonly ConnectedHost[]): ConnectedHost[] {
  const byId = new Map<string, ConnectedHost>();
  for (const host of hosts) {
    const prev = byId.get(host.id);
    if (!prev || host.mountPaths.length > prev.mountPaths.length) byId.set(host.id, host);
  }
  return [...byId.values()];
}
