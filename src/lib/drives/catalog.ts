import { readFile } from "node:fs/promises";
import path from "node:path";

import { DISK_ID } from "@/lib/drives/ids";
import type { CatalogDisk } from "@/lib/drives/types";
import { DEMO_MAC_ID, DEMO_PC_ID } from "@/lib/qbittorrent/demo-data";
import { dataDir } from "@/lib/qbittorrent/store";

/**
 * Demo disks so the scheduler and progress pages work before Drive Manager
 * lands. Same serial+UUID on two hosts shares one download slot.
 */
export function demoDriveCatalog(): CatalogDisk[] {
  return [
    {
      id: DISK_ID.vault,
      serial: "WD-WCAV8TB",
      uuid: "6F4A-VAULT",
      label: "Vault",
      filesystem: "apfs",
      online: true,
      mounts: [{ hostId: DEMO_MAC_ID, os: "darwin", path: "/Volumes/vault" }],
    },
    {
      id: DISK_ID.gamesHdd,
      serial: "SAMSUNG-990-D",
      uuid: "A1B2-GAMES",
      label: "Игры",
      filesystem: "ntfs",
      online: true,
      mounts: [{ hostId: DEMO_PC_ID, os: "win32", path: "D:\\" }],
    },
    {
      id: DISK_ID.gamesSsd,
      serial: "SAMSUNG-990-F",
      uuid: "A1B2-SSD",
      label: "SSD игры",
      filesystem: "ntfs",
      online: true,
      mounts: [{ hostId: DEMO_PC_ID, os: "win32", path: "F:\\" }],
    },
    {
      serial: "HGST-ARCHIVE",
      uuid: "E0E0-ARCHIVE",
      label: "Архив",
      filesystem: "ntfs",
      online: false,
      mounts: [{ hostId: DEMO_PC_ID, os: "win32", path: "E:\\" }],
    },
    {
      id: DISK_ID.media,
      serial: "HGST-MEDIA",
      uuid: "E0E1-MEDIA",
      label: "Медиадиск",
      filesystem: "ntfs",
      online: true,
      mounts: [{ hostId: DEMO_PC_ID, os: "win32", path: "E:\\" }],
    },
  ];
}

/** Policy fixtures: shelf ids, including a disk that is not plugged in. */
export function demoDisks(): CatalogDisk[] {
  return [
    ...demoDriveCatalog().filter((disk) => disk.id),
    {
      id: DISK_ID.offline,
      serial: "SHELF-OFFLINE",
      uuid: "OFFLINE-1",
      label: "Полка",
      filesystem: "ntfs",
      online: false,
      mounts: [{ hostId: DEMO_PC_ID, os: "win32", path: "G:\\" }],
    },
  ];
}

export async function loadDriveCatalog(): Promise<CatalogDisk[]> {
  try {
    const text = await readFile(path.join(dataDir(), "drives.json"), "utf8");
    const parsed = JSON.parse(text) as { disks?: unknown };
    if (!Array.isArray(parsed.disks)) return demoDriveCatalog();
    const disks = parsed.disks.filter(isCatalogDisk);
    return disks.length > 0 ? disks : demoDriveCatalog();
  } catch {
    return demoDriveCatalog();
  }
}

function isCatalogDisk(value: unknown): value is CatalogDisk {
  if (!value || typeof value !== "object") return false;
  const disk = value as CatalogDisk;
  return (
    typeof disk.serial === "string" &&
    disk.serial.length > 0 &&
    typeof disk.uuid === "string" &&
    disk.uuid.length > 0 &&
    typeof disk.label === "string" &&
    disk.label.length > 0 &&
    typeof disk.online === "boolean" &&
    Array.isArray(disk.mounts)
  );
}
