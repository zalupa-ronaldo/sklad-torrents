import { mountPathsOf, online } from "@/addons/drives/reconcile";
import type { DiskRecord, DiskView } from "@/addons/drives/types";

const HIDDEN_LABEL = /^(efi|recovery|preboot|update|vm|xart|hardware|iscpreboot)$/i;
const HIDDEN_MOUNT = /\/system\/volumes\/|efi|recovery|preboot|iscpreboot|xarts?|(^|\/)hardware$/i;

/** Volumes shown in the file browser tree. Includes C:/S:/E:/vault. Never Z for live work; snapshot OK if already indexed. */
export function isBrowsableDisk(disk: Pick<DiskView, "label" | "lastMountPath" | "mountPaths" | "fileCount" | "totalBytes" | "filesystem">): boolean {
  const mounts = [...(disk.mountPaths ?? []), disk.lastMountPath].filter(Boolean);
  if (HIDDEN_LABEL.test(disk.label.trim())) return false;
  if (mounts.length > 0 && mounts.every((path) => HIDDEN_MOUNT.test(path))) return false;
  // Tiny recovery/EFI slices without a library
  if (disk.totalBytes > 0 && disk.totalBytes < 2_000_000_000 && disk.fileCount === 0) return false;
  return true;
}

/** Compact bottom strip: meaningful storage, still includes C: if it has indexed files. */
export function isStripDisk(disk: Pick<DiskView, "label" | "lastMountPath" | "mountPaths" | "fileCount" | "totalBytes" | "online" | "filesystem">): boolean {
  if (!isBrowsableDisk(disk)) return false;
  const mounts = [...(disk.mountPaths ?? []), disk.lastMountPath].filter(Boolean);
  if (mounts.some((path) => /^z:\\/i.test(path))) return disk.fileCount > 0; // shelf only if snapshot exists
  if (disk.fileCount > 0) return true;
  // Online capacity strip: skip empty placeholders (0 B / NO NAME with no index)
  if (!disk.online) return false;
  if (disk.totalBytes < 1_000_000_000) return false;
  if (/^NO NAME/i.test(disk.label || "")) return false;
  return true;
}

export function isBrowsableRecord(disk: DiskRecord): boolean {
  return isBrowsableDisk({
    label: disk.label,
    lastMountPath: disk.lastMountPath,
    mountPaths: mountPathsOf(disk),
    fileCount: disk.files.length,
    totalBytes: disk.totalBytes,
    filesystem: disk.filesystem,
  });
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

/** @deprecated use isStripDisk / isBrowsableDisk */
export function isPrimaryInventoryDisk(disk: Parameters<typeof isStripDisk>[0]): boolean {
  return isStripDisk(disk);
}

export function isPrimaryInventoryRecord(disk: DiskRecord): boolean {
  return isBrowsableRecord(disk);
}
