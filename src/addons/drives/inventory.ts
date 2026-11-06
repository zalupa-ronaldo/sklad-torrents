import { mountPathsOf } from "@/addons/drives/reconcile";
import type { DiskRecord, DiskView } from "@/addons/drives/types";
import { formatBytes } from "@/lib/format";

const JUNK_NAME = /^(efi|recovery|preboot|update|vm|xart|hardware|iscpreboot)$/i;
/** Junk APFS helper volumes only. `/System/Volumes/Data` is the user volume and stays visible. */
const JUNK_MOUNT = /\/system\/volumes\/(preboot|recovery|vm|update|hardware|iscpreboot|xart)(\/|$)|(^|\/)(efi|recovery|preboot|iscpreboot|xarts?|hardware)(\/|$)/i;

type DiskFace = {
  id?: string;
  label: string;
  volumeName?: string;
  lastMountPath: string;
  mountPaths?: readonly string[];
  fileCount?: number;
  totalBytes: number;
  serial?: string;
  lastHostId?: string;
};

function faceMounts(disk: DiskFace): string[] {
  return [...(disk.mountPaths ?? []), disk.lastMountPath].filter(Boolean);
}

function faceName(disk: DiskFace): string {
  return `${disk.volumeName || ""} ${disk.label || ""}`.trim();
}

export function isDataVolume(disk: DiskFace): boolean {
  const mounts = faceMounts(disk).map((path) => path.replace(/\\/g, "/"));
  if (mounts.some((path) => /\/system\/volumes\/data$/i.test(path))) return true;
  return /macintosh hd\s*-\s*data$/i.test(faceName(disk));
}

export function isSealedSystemVolume(disk: DiskFace): boolean {
  if (isDataVolume(disk)) return false;
  const mounts = faceMounts(disk);
  if (mounts.some((path) => path === "/")) return true;
  return /^macintosh hd$/i.test(faceName(disk).trim());
}

function samePhysicalDisk(left: DiskFace, right: DiskFace): boolean {
  const serialA = (left.serial || "").trim().toLowerCase();
  const serialB = (right.serial || "").trim().toLowerCase();
  if (serialA && serialB && serialA === serialB) return true;
  return Boolean(left.lastHostId && left.lastHostId === right.lastHostId && isSealedSystemVolume(left) && isDataVolume(right));
}

/** One SSD must not appear twice: the sealed Macintosh HD is hidden while its Data volume is present. */
export function hiddenByDataTwin(disk: DiskFace, siblings: readonly DiskFace[]): boolean {
  if (!isSealedSystemVolume(disk)) return false;
  return siblings.some((other) => other !== disk && other.id !== disk.id && isDataVolume(other) && samePhysicalDisk(disk, other));
}

function isJunkVolume(disk: DiskFace): boolean {
  if (JUNK_NAME.test(disk.label.trim())) return true;
  if (disk.volumeName && JUNK_NAME.test(disk.volumeName.trim())) return true;
  const mounts = faceMounts(disk);
  return mounts.length > 0 && mounts.every((path) => JUNK_MOUNT.test(path));
}

/** Volumes shown in the file browser. Preboot/VM/Recovery stay hidden. Data and an empty online disk stay. */
export function isBrowsableDisk(disk: Pick<DiskView, "label" | "volumeName" | "lastMountPath" | "mountPaths" | "fileCount" | "totalBytes" | "filesystem" | "serial" | "lastHostId" | "id">, siblings: readonly DiskFace[] = []): boolean {
  if (isJunkVolume(disk)) return false;
  if (hiddenByDataTwin(disk, siblings.length > 0 ? siblings : [disk])) return false;
  // Tiny recovery/EFI slices without a library
  if (disk.totalBytes > 0 && disk.totalBytes < 2_000_000_000 && disk.fileCount === 0) return false;
  return true;
}

/** Bottom strip and the disk tree. Online capacity is enough; an empty index does not hide the disk. */
export function isStripDisk(disk: Pick<DiskView, "id" | "label" | "volumeName" | "lastMountPath" | "mountPaths" | "fileCount" | "totalBytes" | "online" | "filesystem" | "serial" | "lastHostId">, siblings: readonly DiskFace[] = []): boolean {
  if (!isBrowsableDisk(disk, siblings.length > 0 ? siblings : [disk])) return false;
  if (disk.fileCount > 0) return true;
  if (!disk.online) return false;
  if (disk.totalBytes < 1_000_000_000) return false;
  if (/^NO NAME/i.test(disk.label || "")) return false;
  return true;
}

export function visibleShelfDisks<T extends DiskFace & { online?: boolean }>(disks: readonly T[]): T[] {
  return disks.filter((disk) => isStripDisk(disk as unknown as Parameters<typeof isStripDisk>[0], disks));
}

export function isBrowsableRecord(disk: DiskRecord, siblings: readonly DiskRecord[] = [disk]): boolean {
  return isBrowsableDisk({
    id: disk.id,
    label: disk.label,
    volumeName: disk.volumeName,
    lastMountPath: disk.lastMountPath,
    mountPaths: mountPathsOf(disk),
    fileCount: disk.files.length,
    totalBytes: disk.totalBytes,
    filesystem: disk.filesystem,
    serial: disk.serial,
    lastHostId: disk.lastHostId,
  }, siblings.map((item) => ({
    id: item.id,
    label: item.label,
    volumeName: item.volumeName,
    lastMountPath: item.lastMountPath,
    mountPaths: mountPathsOf(item),
    fileCount: item.files.length,
    totalBytes: item.totalBytes,
    serial: item.serial,
    lastHostId: item.lastHostId,
  })));
}

export function displayDiskName(disk: Pick<DiskView, "label" | "volumeName" | "lastMountPath" | "mountPaths">): string {
  const path = disk.mountPaths?.[0] || disk.lastMountPath || "";
  if (/^[A-Za-z]:\\?/.test(path)) return path.slice(0, 2).toUpperCase();
  if (path.startsWith("/Volumes/")) {
    const leaf = path.slice("/Volumes/".length).split("/")[0];
    if (leaf) return leaf;
  }
  const label = (disk.label || "").trim();
  if (label && label !== "Без имени" && !/�/.test(label)) return label;
  const volume = (disk.volumeName || "").trim();
  if (volume && volume !== "Без имени" && !/�/.test(volume)) return volume;
  return path || "Диск";
}


/** Removable USB / flash-style volumes (FAT on /Volumes or Windows removable letters). */
export function isRemovableDisk(disk: Pick<DiskView, "filesystem" | "lastMountPath" | "mountPaths" | "totalBytes" | "label" | "volumeName">): boolean {
  const fs = (disk.filesystem || "").toLowerCase();
  const fatLike = /msdos|fat32|\bfat\b|exfat|vfat/.test(fs);
  const mounts = [...(disk.mountPaths ?? []), disk.lastMountPath].filter(Boolean);
  if (fatLike && mounts.some((path) => path.startsWith("/Volumes/"))) return true;
  if (fatLike && disk.totalBytes > 0 && disk.totalBytes < 128_000_000_000) return true;
  return false;
}

/** "12 ТБ · S:" / "Флешка · 16 ГБ · NO NAME 1" — capacity from real totalBytes only. */
export function displayDiskTitle(disk: Pick<DiskView, "label" | "volumeName" | "lastMountPath" | "mountPaths" | "totalBytes" | "filesystem">): string {
  const name = displayDiskName(disk);
  const capacity = disk.totalBytes > 0 ? formatBytes(disk.totalBytes) : "";
  const flash = isRemovableDisk(disk) ? "Флешка · " : "";
  if (capacity && name) return `${flash}${capacity} · ${name}`;
  return `${flash}${name || capacity || "Диск"}`;
}

/** Picker line with free space: "16 ГБ · NO NAME 1 — свободно 14,2 ГБ". */
export function displayDiskPickerLabel(disk: Pick<DiskView, "label" | "volumeName" | "lastMountPath" | "mountPaths" | "totalBytes" | "freeBytes" | "filesystem">): string {
  const title = displayDiskTitle(disk);
  if (disk.freeBytes > 0) return `${title} — свободно ${formatBytes(disk.freeBytes)}`;
  return title;
}

/** @deprecated use isStripDisk / isBrowsableDisk */
export function isPrimaryInventoryDisk(disk: Parameters<typeof isStripDisk>[0]): boolean {
  return isStripDisk(disk);
}

export function isPrimaryInventoryRecord(disk: DiskRecord): boolean {
  return isBrowsableRecord(disk);
}
