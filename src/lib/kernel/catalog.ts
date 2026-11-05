import { randomUUID } from "node:crypto";

import { demoDisks } from "@/lib/kernel/demo-seed";
import { SkladError } from "@/lib/kernel/errors";
import { matchDisk } from "@/lib/kernel/identity";
import { readJsonFile, writeJsonFile } from "@/lib/kernel/json-file";
import { enqueueJob } from "@/lib/kernel/jobs";
import { withLock } from "@/lib/kernel/lock";
import { pageOf } from "@/lib/kernel/page";
import type { CatalogFile, DiskProbe, DiskRecord, JobRecord, Page, SearchHit } from "@/lib/kernel/types";
import { volumeRoot } from "@/lib/kernel/volume";

const FILE = "catalog.json";

interface CatalogFileJson {
  disks: DiskRecord[];
}

function normalizeMountPoint(os: DiskProbe["os"], mountPoint: string): string {
  return volumeRoot(os, mountPoint);
}

async function readAll(): Promise<DiskRecord[] | null> {
  const file = await readJsonFile<CatalogFileJson>(FILE);
  if (!file) return null;
  if (!Array.isArray(file.disks)) return [];
  return file.disks;
}

async function writeAll(disks: DiskRecord[]): Promise<void> {
  await writeJsonFile(FILE, { disks });
}

export async function listDisks(): Promise<DiskRecord[]> {
  return withLock("disks", async () => (await readAll()) ?? []);
}

export async function getDisk(id: string): Promise<DiskRecord> {
  const disks = await listDisks();
  const disk = disks.find((item) => item.id === id);
  if (!disk) throw new SkladError("not_found", "Диск не найден в каталоге.");
  return disk;
}

export async function saveDisks(disks: DiskRecord[]): Promise<void> {
  await withLock("disks", async () => {
    await writeAll(disks);
  });
}

export async function ensureDemoCatalog(): Promise<DiskRecord[]> {
  return withLock("disks", async () => {
    const existing = await readAll();
    if (existing) return existing;
    const seeded = demoDisks();
    await writeAll(seeded);
    return seeded;
  });
}

export function searchDisks(disks: DiskRecord[], query: string, offset = 0, limit = 40): Page<SearchHit> {
  const needle = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const disk of disks) {
    const files = needle
      ? disk.files.filter((file) => file.path.toLowerCase().includes(needle))
      : disk.files.slice(0, 20);
    const located = needle
      ? disk.located.filter((item) => item.name.toLowerCase().includes(needle) || item.path.toLowerCase().includes(needle))
      : [];
    const labelHit = !needle || disk.label.toLowerCase().includes(needle);
    if (needle && files.length === 0 && located.length === 0 && !labelHit) continue;
    const rows = files.length > 0 ? files : located.map((item) => ({ path: item.path, size: 0 }));
    const shown = rows.length > 0 ? rows : [{ path: "", size: 0 }];
    for (const row of shown) {
      hits.push(hitFor(disk, row));
    }
  }
  return pageOf(hits, offset, limit);
}

function hitFor(disk: DiskRecord, file: CatalogFile): SearchHit {
  const place = disk.online
    ? (disk.mounts[0]?.mountPoint ?? disk.lastMount?.mountPoint ?? "")
    : (disk.lastMount?.mountPoint ?? "");
  const path = file.path ? `${place}${place.endsWith("\\") || place.endsWith("/") ? "" : place.includes("\\") ? "\\" : "/"}${file.path}` : place;
  const message = disk.online
    ? `Диск «${disk.label}», путь ${path}`
    : `Диск «${disk.label}» не подключён. Подключите его, чтобы открыть ${file.path || "корень"}.`;
  return {
    diskId: disk.id,
    label: disk.label,
    online: disk.online,
    filesystem: disk.filesystem,
    path: file.path || place,
    size: file.size,
    message,
  };
}

export interface IngestResult {
  disk: DiskRecord;
  created: boolean;
  duplicateMount: boolean;
  cloneOf: string | null;
  indexJob: JobRecord | null;
}

/**
 * Auto-detect entry point. Updates identity bookkeeping and enqueues a
 * read-only index job. Does not scan, compact, move, or delete inside the call.
 */
export async function ingestProbe(probe: DiskProbe): Promise<IngestResult> {
  return withLock("disks", async () => {
    const disks = (await readAll()) ?? [];
    const fresh = matchDisk(disks, probe);
    const now = Date.now();
    const mounts = probe.online
      ? uniqueMounts(probe.hostId, probe.mountPoints.map((point) => normalizeMountPoint(probe.os, point)))
      : [];
    let disk: DiskRecord;
    let created = false;
    let cloneOf: string | null = null;
    if (fresh.kind === "same") {
      const current = disks.find((item) => item.id === fresh.diskId);
      if (!current) throw new SkladError("not_found", "Запись диска потерялась.");
      disk = current;
      const others = disk.mounts.filter((mount) => mount.hostId !== probe.hostId);
      disk.mounts = probe.online ? [...others, ...mounts] : others;
      disk.online = disk.mounts.length > 0;
      if (mounts[0]) disk.lastMount = mounts[0];
      disk.lastSeen = now;
      disk.lastHostId = probe.hostId;
      disk.totalBytes = probe.totalBytes;
      disk.freeBytes = probe.freeBytes;
      disk.filesystem = probe.filesystem;
      disk.elevated = probe.elevated;
      disk.heavyActivity = Boolean(probe.heavyActivity);
      if (probe.label?.trim()) disk.label = probe.label.trim();
    } else {
      if (fresh.kind === "clone") cloneOf = fresh.diskId;
      created = true;
      const id = `disk-${randomUUID()}`;
      disk = {
        id,
        serial: probe.serial.trim(),
        volumeUuid: probe.volumeUuid.trim(),
        filesystem: probe.filesystem,
        label: probe.label?.trim() || `Диск ${probe.serial.trim()}`,
        totalBytes: probe.totalBytes,
        freeBytes: probe.freeBytes,
        online: probe.online && mounts.length > 0,
        mounts,
        lastMount: mounts[0] ?? null,
        lastSeen: now,
        lastHostId: probe.hostId,
        files: [],
        indexStatus: "idle",
        indexMethod: null,
        indexError: null,
        indexedAt: null,
        heavyActivity: Boolean(probe.heavyActivity),
        elevated: probe.elevated,
        located: [],
      };
      disks.push(disk);
    }
    await writeAll(disks);
    const duplicateMount = disk.mounts.filter((mount) => mount.hostId === probe.hostId).length > 1;
    let indexJob: JobRecord | null = null;
    if (probe.online) {
      const queued = await enqueueJob({
        kind: "index",
        hostId: probe.hostId,
        title: `Индексация «${disk.label}»`,
        source: `disk:${disk.id}`,
        destination: `disk:${disk.id}`,
        totalBytes: Math.max(1, disk.files.length),
        currentFile: disk.mounts[0]?.mountPoint || disk.label,
        message: "В очереди. Автоиндексация только читает каталог и ничего не удаляет.",
        payload: { readOnly: true, diskId: disk.id, sourceDeleted: false },
      });
      indexJob = queued.job;
    }
    return { disk, created, duplicateMount, cloneOf, indexJob };
  });
}

function uniqueMounts(hostId: string, mountPoints: string[]): { hostId: string; mountPoint: string }[] {
  const seen = new Set<string>();
  const mounts: { hostId: string; mountPoint: string }[] = [];
  for (const mountPoint of mountPoints) {
    if (!mountPoint || seen.has(mountPoint)) continue;
    seen.add(mountPoint);
    mounts.push({ hostId, mountPoint });
  }
  return mounts;
}

export async function updateDiskFiles(id: string, files: CatalogFile[], status: DiskRecord["indexStatus"], method: DiskRecord["indexMethod"], error: string | null): Promise<DiskRecord> {
  return withLock("disks", async () => {
    const disks = (await readAll()) ?? [];
    const disk = disks.find((item) => item.id === id);
    if (!disk) throw new SkladError("not_found", "Диск не найден в каталоге.");
    if (status === "complete" && method) {
      disk.files = files;
      disk.indexStatus = "complete";
      disk.indexMethod = method;
      disk.indexError = null;
      disk.indexedAt = Date.now();
    } else {
      disk.indexStatus = status;
      disk.indexError = error;
    }
    await writeAll(disks);
    return disk;
  });
}

export async function setHeavyActivity(id: string, heavy: boolean): Promise<void> {
  await withLock("disks", async () => {
    const disks = (await readAll()) ?? [];
    const disk = disks.find((item) => item.id === id);
    if (!disk) return;
    disk.heavyActivity = heavy;
    await writeAll(disks);
  });
}
