import type { HostOs } from "@/lib/qbittorrent/types";

/**
 * Seam for Drive Manager. A real catalog can replace the demo list by
 * writing `data/drives.json` (`{ disks: CatalogDisk[] }`). Progress and the
 * download scheduler only depend on this shape.
 */
export interface DriveMount {
  /** Limit the mount to one qBittorrent host. Empty means any host. */
  hostId?: string;
  os: HostOs;
  /** Prefix of the save path on that machine, e.g. `/Volumes/vault` or `D:\`. */
  path: string;
}

export type VolumeFilesystem = "ntfs" | "apfs" | "hfs" | "exfat" | "other";

export interface CatalogDisk {
  /** Stable shelf id used by content rules. Identity for matching hardware is still serial + uuid. */
  id?: string;
  serial: string;
  uuid: string;
  label: string;
  online: boolean;
  filesystem?: VolumeFilesystem;
  mounts: DriveMount[];
}
