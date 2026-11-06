import { readFile } from "node:fs/promises";
import path from "node:path";

import { DISK_ID } from "@/lib/drives/ids";
import type { CatalogDisk, DriveMount, VolumeFilesystem } from "@/lib/drives/types";
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

function mapFilesystem(value: unknown): VolumeFilesystem | undefined {
  const raw = String(value || "").toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("ntfs")) return "ntfs";
  if (raw.includes("apfs")) return "apfs";
  if (raw.includes("hfs")) return "hfs";
  if (raw.includes("exfat")) return "exfat";
  return "other";
}

function mapOs(pathValue: string, hostOs?: string): DriveMount["os"] {
  if (hostOs === "win32" || hostOs === "darwin") return hostOs;
  if (/^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.includes("\\")) return "win32";
  return "darwin";
}

function mapHostId(raw: unknown): string | undefined {
  const value = String(raw || "");
  if (!value) return undefined;
  if (value === "windows-pc" || value === "pc-real") return "pc-real";
  if (value === "mac-mini" || value === "mac-real") return "mac-real";
  return value;
}

/** Convert shelf DiskRecord (or legacy CatalogDisk) rows into policy/scheduler mounts. */
export function adaptShelfDisk(value: unknown): CatalogDisk | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  if (isLegacyCatalogDisk(raw)) return raw as unknown as CatalogDisk;

  const serial = typeof raw.serial === "string" ? raw.serial : "";
  const uuid =
    typeof raw.volumeUuid === "string" && raw.volumeUuid
      ? raw.volumeUuid
      : typeof raw.uuid === "string"
        ? raw.uuid
        : "";
  const label = typeof raw.label === "string" ? raw.label : typeof raw.volumeName === "string" ? raw.volumeName : "";
  if (!label) return null;

  const mountPaths = Array.isArray(raw.mountPaths)
    ? raw.mountPaths.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const lastMountPath = typeof raw.lastMountPath === "string" ? raw.lastMountPath : "";
  const paths = mountPaths.length > 0 ? mountPaths : lastMountPath ? [lastMountPath] : [];
  // Exclude dying Z: from placement targets entirely.
  const usable = paths.filter((item) => !/^z:\\/i.test(item));
  if (usable.length === 0 && paths.some((item) => /^z:\\/i.test(item))) {
    return {
      id: typeof raw.id === "string" ? raw.id : undefined,
      serial: serial || `unknown-${label}`,
      uuid: uuid || `unknown-${label}`,
      label,
      online: false,
      filesystem: mapFilesystem(raw.filesystem),
      mounts: [],
    };
  }

  const hostId = mapHostId(raw.lastHostId);
  const mounts: DriveMount[] = (usable.length ? usable : paths).map((mountPath) => ({
    hostId,
    os: mapOs(mountPath),
    path: mountPath,
  }));

  const online = Boolean(raw.online) && mounts.length > 0;
  return {
    id: typeof raw.id === "string" ? raw.id : undefined,
    serial: serial || `unknown-${label}`,
    uuid: uuid || `unknown-${label}`,
    label,
    online,
    filesystem: mapFilesystem(raw.filesystem),
    mounts,
  };
}

function isLegacyCatalogDisk(value: Record<string, unknown>): boolean {
  return (
    typeof value.serial === "string" &&
    value.serial.length > 0 &&
    typeof value.uuid === "string" &&
    value.uuid.length > 0 &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    typeof value.online === "boolean" &&
    Array.isArray(value.mounts) &&
    (value.mounts as unknown[]).every((mount) => mount && typeof mount === "object" && typeof (mount as DriveMount).path === "string")
  );
}

export async function loadDriveCatalog(): Promise<CatalogDisk[]> {
  try {
    const text = await readFile(path.join(dataDir(), "drives.json"), "utf8");
    const parsed = JSON.parse(text) as { disks?: unknown };
    if (!Array.isArray(parsed.disks)) return demoDriveCatalog();
    const disks = parsed.disks.map(adaptShelfDisk).filter((disk): disk is CatalogDisk => Boolean(disk));
    return disks.length > 0 ? disks : demoDriveCatalog();
  } catch {
    return demoDriveCatalog();
  }
}
