import type { CatalogDisk, DriveMount } from "@/lib/drives/types";
import type { HostOs } from "@/lib/qbittorrent/types";
import { catalogDiskKey } from "@/lib/scheduler/disk-key";

export type VolumeFilesystem = "ntfs" | "apfs" | "exfat" | "other";

export interface PolicyDisk {
  id: string;
  label: string;
  online: boolean;
  filesystem: VolumeFilesystem;
  mountPath: string;
  hostId: string;
  hostName: string;
  os: HostOs;
  disk: CatalogDisk;
}

export function diskKey(disk: CatalogDisk): string {
  return catalogDiskKey(disk.serial, disk.uuid);
}

export function toPolicyDisk(disk: CatalogDisk, hostName = ""): PolicyDisk {
  const mount = primaryMount(disk);
  const os = mount?.os ?? "darwin";
  return {
    id: disk.id || diskKey(disk),
    label: disk.label,
    online: disk.online,
    filesystem: filesystemOf(disk),
    mountPath: mount?.path ?? "",
    hostId: mount?.hostId ?? "",
    hostName,
    os,
    disk,
  };
}

export function filesystemOf(disk: CatalogDisk): VolumeFilesystem {
  const declared = (disk as CatalogDisk & { filesystem?: string }).filesystem;
  if (declared === "ntfs" || declared === "apfs" || declared === "exfat" || declared === "other") return declared;
  const os = primaryMount(disk)?.os;
  if (os === "darwin") return "apfs";
  if (os === "win32") return "ntfs";
  return "other";
}

export function primaryMount(disk: CatalogDisk): DriveMount | null {
  return disk.mounts.find((mount) => mount.path) ?? null;
}

export function pathOnDisk(savePath: string, disk: CatalogDisk): boolean {
  return disk.mounts.some((mount) => mountMatches(mount.os, savePath, mount.path));
}

function mountMatches(os: HostOs, savePath: string, root: string): boolean {
  const path = slash(savePath).replace(/\/+$/, "").toLowerCase();
  const base = slash(root).replace(/\/+$/, "").toLowerCase();
  if (!path || !base) return false;
  return path === base || path.startsWith(`${base}/`);
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}
