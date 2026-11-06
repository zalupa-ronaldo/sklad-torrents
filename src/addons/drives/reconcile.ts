import { applyIndexUpdate, emptyScan } from "@/addons/drives/index-apply";
import { anonymousDiskId, formatUuid, identityKey, normalizeSerial, normalizeUuid, stableDiskId } from "@/addons/drives/identity";
import type {
  ConnectedHost,
  DiskRecord,
  HostObservation,
  IndexedFile,
  LibraryRule,
  ObservedVolume,
  PathStyle,
} from "@/addons/drives/types";

function cloneDisks(disks: readonly DiskRecord[]): DiskRecord[] {
  return disks.map((disk) => ({ ...disk, scan: { ...disk.scan }, connectedHosts: disk.connectedHosts.map((host) => ({ ...host, mountPaths: [...host.mountPaths] })), cloneOfIds: [...disk.cloneOfIds] }));
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const text = path.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function mergeObserved(volumes: readonly ObservedVolume[]): ObservedVolume[] {
  const merged: ObservedVolume[] = [];
  const indexByKey = new Map<string, number>();
  for (const volume of volumes) {
    const key = identityKey(volume.serial, volume.volumeUuid);
    if (!key) {
      merged.push({ ...volume, mountPaths: uniquePaths(volume.mountPaths) });
      continue;
    }
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push({ ...volume, mountPaths: uniquePaths(volume.mountPaths) });
      continue;
    }
    const existing = merged[existingIndex];
    existing.mountPaths = uniquePaths([...existing.mountPaths, ...volume.mountPaths]);
    existing.busy = existing.busy || volume.busy;
    existing.totalBytes = volume.totalBytes || existing.totalBytes;
    existing.freeBytes = volume.freeBytes || existing.freeBytes;
    if (volume.index && (!existing.index || volume.index.state === "complete")) existing.index = volume.index;
  }
  return merged;
}

function mountsOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 && right.length === 0) return true;
  const known = new Set(left);
  return right.some((path) => known.has(path));
}

function findDisk(
  disks: DiskRecord[],
  volume: ObservedVolume,
  hostId: string,
  alreadySeen: ReadonlySet<string>,
): DiskRecord | undefined {
  const serialNorm = normalizeSerial(volume.serial);
  const uuidNorm = normalizeUuid(volume.volumeUuid);
  if (!uuidNorm) return undefined;
  if (serialNorm) {
    return disks.find((disk) => disk.serialNorm === serialNorm && disk.uuidNorm === uuidNorm);
  }
  // Missing serial is not proof of identity. Continue a record only while the same
  // host still has it at an overlapping mount. Anything else is a separate disk.
  return disks.find(
    (disk) =>
      !alreadySeen.has(disk.id) &&
      disk.serialNorm === "" &&
      disk.uuidNorm === uuidNorm &&
      disk.connectedHosts.some((host) => host.id === hostId && mountsOverlap(host.mountPaths, volume.mountPaths)),
  );
}

function styleFor(os: HostObservation["os"]): PathStyle {
  return os === "win32" ? "win32" : "posix";
}

function createDisk(volume: ObservedVolume, observation: HostObservation, at: string, mountPaths: string[]): DiskRecord {
  const serialNorm = normalizeSerial(volume.serial);
  const uuidNorm = normalizeUuid(volume.volumeUuid);
  const id = serialNorm ? stableDiskId(volume.serial, volume.volumeUuid) : anonymousDiskId();
  return {
    id,
    serial: volume.serial.trim(),
    serialNorm,
    volumeUuid: formatUuid(uuidNorm),
    uuidNorm,
    filesystem: volume.filesystem.trim() || "unknown",
    label: volume.volumeName.trim() || "Без имени",
    namedByUser: false,
    volumeName: volume.volumeName.trim(),
    totalBytes: volume.totalBytes,
    freeBytes: volume.freeBytes,
    lastSeenAt: at,
    lastHostId: observation.hostId,
    lastHostName: observation.hostName,
    pathStyle: styleFor(observation.os),
    lastMountPath: mountPaths[0] ?? "",
    priorMountPath: "",
    connectedHosts: [],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: emptyScan(),
    files: [],
  };
}

function connect(disk: DiskRecord, observation: HostObservation, mountPaths: string[]): void {
  const next: ConnectedHost = {
    id: observation.hostId,
    name: observation.hostName,
    os: observation.os,
    elevated: observation.elevated,
    mountPaths,
  };
  disk.connectedHosts = [...disk.connectedHosts.filter((host) => host.id !== observation.hostId), next];
  disk.duplicateMounts = disk.connectedHosts.some((host) => host.mountPaths.length > 1);
  const primary = mountPaths[0] ?? disk.lastMountPath;
  if (primary && disk.lastMountPath && primary !== disk.lastMountPath) disk.priorMountPath = disk.lastMountPath;
  if (primary) disk.lastMountPath = primary;
  disk.lastHostId = observation.hostId;
  disk.lastHostName = observation.hostName;
  disk.pathStyle = styleFor(observation.os);
}

function refreshClones(disks: DiskRecord[]): void {
  const groups = new Map<string, DiskRecord[]>();
  for (const disk of disks) {
    disk.possibleClone = false;
    disk.cloneOfIds = [];
    if (!disk.uuidNorm) continue;
    const list = groups.get(disk.uuidNorm) ?? [];
    list.push(disk);
    groups.set(disk.uuidNorm, list);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const serials = new Set(group.map((disk) => disk.serialNorm));
    const missing = group.some((disk) => !disk.serialNorm);
    if (serials.size < 2 && !missing) continue;
    for (const disk of group) {
      disk.possibleClone = true;
      disk.cloneOfIds = group.filter((other) => other.id !== disk.id).map((other) => other.id);
    }
  }
}

function collapse(disks: DiskRecord[]): DiskRecord[] {
  const byKey = new Map<string, DiskRecord>();
  const anonymous: DiskRecord[] = [];
  for (const disk of disks) {
    const key = identityKey(disk.serial, disk.volumeUuid);
    if (!key) {
      anonymous.push(disk);
      continue;
    }
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, disk);
      continue;
    }
    if (disk.files.length > prev.files.length) prev.files = disk.files;
    if (disk.namedByUser && !prev.namedByUser) {
      prev.label = disk.label;
      prev.namedByUser = true;
    }
    prev.connectedHosts = disk.connectedHosts.length > prev.connectedHosts.length ? disk.connectedHosts : prev.connectedHosts;
  }
  return [...byKey.values(), ...anonymous];
}

export function reconcileCatalog(
  current: readonly DiskRecord[],
  observations: readonly HostObservation[],
  libraries: readonly LibraryRule[],
  at: string,
): DiskRecord[] {
  const disks = collapse(cloneDisks(current));
  const reported = new Set(observations.map((observation) => observation.hostId));
  const seen = new Map<string, Set<string>>();

  for (const observation of observations) {
    const volumes = mergeObserved(observation.volumes).filter((volume) => normalizeUuid(volume.volumeUuid));
    const seenIds = new Set<string>();
    for (const volume of volumes) {
      const mountPaths = uniquePaths(volume.mountPaths);
      let disk = findDisk(disks, volume, observation.hostId, seenIds);
      if (!disk) {
        disk = createDisk(volume, observation, at, mountPaths);
        disks.push(disk);
      }
      disk.filesystem = volume.filesystem.trim() || disk.filesystem;
      disk.volumeName = volume.volumeName.trim() || disk.volumeName;
      if (Number.isFinite(volume.totalBytes) && volume.totalBytes > 0) disk.totalBytes = volume.totalBytes;
      if (Number.isFinite(volume.freeBytes) && volume.freeBytes >= 0) disk.freeBytes = volume.freeBytes;
      disk.lastSeenAt = at;
      connect(disk, observation, mountPaths);
      const applied = applyIndexUpdate({
        previous: disk.files,
        previousScan: disk.scan,
        update: volume.busy ? { ...(volume.index ?? { state: "paused", progress: disk.scan.progress }), state: "paused" } : volume.index,
        busy: volume.busy,
        libraries,
        pathStyle: disk.pathStyle,
        mountPath: disk.lastMountPath,
        filesystem: disk.filesystem,
        platform: observation.os,
        elevated: observation.elevated,
      });
      disk.files = applied.files;
      disk.scan = applied.scan;
      if (typeof volume.index?.recordCount === "number") disk.reportedRecords = volume.index.recordCount;
      if (volume.index?.deferred && volume.index.revision) disk.pendingRevision = volume.index.revision;
      else if (volume.index?.revision && !volume.index.deferred) {
        disk.indexRevision = volume.index.revision;
        disk.pendingRevision = undefined;
      }
      seenIds.add(disk.id);
    }
    seen.set(observation.hostId, seenIds);
  }

  for (const disk of disks) {
    if (![...reported].some((hostId) => disk.connectedHosts.some((host) => host.id === hostId))) continue;
    disk.connectedHosts = disk.connectedHosts.filter((host) => {
      if (!reported.has(host.id)) return true;
      return seen.get(host.id)?.has(disk.id) ?? false;
    });
    disk.duplicateMounts = disk.connectedHosts.some((host) => host.mountPaths.length > 1);
  }
  refreshClones(disks);
  return disks;
}

export function online(disk: DiskRecord): boolean {
  return disk.connectedHosts.length > 0;
}

export function mountPathsOf(disk: DiskRecord): string[] {
  return disk.connectedHosts.flatMap((host) => host.mountPaths);
}

export function fileCount(files: readonly IndexedFile[]): number {
  return files.filter((file) => file.kind === "file").length;
}
