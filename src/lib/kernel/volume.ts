import type { HostOs } from "@/lib/qbittorrent/types";

import type { DiskMount, DiskRecord, Filesystem } from "@/lib/kernel/types";

export interface SlotDisk {
  id: string;
  label: string;
  filesystem: Filesystem;
  online: boolean;
  mounts: DiskMount[];
  lastMount: DiskMount | null;
}

export interface SlotRef {
  key: string;
  label: string;
  mode: "disk" | "fallback";
  diskId: string | null;
  online: boolean;
  filesystem: Filesystem | null;
  note: string | null;
}

export function volumeRoot(os: HostOs, fullPath: string): string {
  if (os === "win32") {
    const match = fullPath.replace(/\//g, "\\").match(/^([A-Za-z]:\\)/);
    if (!match?.[1]) return fullPath;
    return `${match[1][0]!.toUpperCase()}:\\`;
  }
  const unix = fullPath.replace(/\\/g, "/");
  const volumes = unix.match(/^\/Volumes\/[^/]+/);
  if (volumes) return volumes[0];
  if (unix.startsWith("/")) return "/";
  return unix;
}

export function isVaultPath(input: string): boolean {
  const path = input.replace(/\\/g, "/").replace(/\/+$/, "");
  return path === "/Volumes/vault" || path.startsWith("/Volumes/vault/");
}

export function pathOnMount(mountPoint: string, fullPath: string, os: HostOs): boolean {
  if (os === "win32") {
    const root = volumeRoot("win32", mountPoint).toUpperCase();
    const path = fullPath.replace(/\//g, "\\").toUpperCase();
    if (!/^[A-Z]:\\/.test(root)) return false;
    return path.startsWith(root);
  }
  const root = volumeRoot("darwin", mountPoint);
  const path = fullPath.replace(/\\/g, "/");
  if (root === "/") return path.startsWith("/") && !path.startsWith("/Volumes/");
  return path === root || path.startsWith(`${root}/`);
}

export function slotOfDisk(disk: SlotDisk): SlotRef {
  return {
    key: `disk:${disk.id}`,
    label: disk.label,
    mode: "disk",
    diskId: disk.id,
    online: disk.online,
    filesystem: disk.filesystem,
    note: disk.online ? null : `Диск «${disk.label}» не подключён. Очередь ждёт.`,
  };
}

/**
 * Attach a qBittorrent path to a physical disk.
 * Online mounts are a current connection, not identity.
 * An offline disk may be recognized by the last mount only when that
 * volume root is not taken by another online disk. Otherwise the slot
 * falls back to host + volume root and is not stored as identity.
 */
export function resolveSlot(disks: SlotDisk[], hostId: string, os: HostOs, savePath: string): SlotRef {
  for (const disk of disks) {
    if (!disk.online) continue;
    if (disk.mounts.some((mount) => mount.hostId === hostId && pathOnMount(mount.mountPoint, savePath, os))) {
      return slotOfDisk(disk);
    }
  }

  const offline = disks.filter((disk) => {
    if (disk.online || !disk.lastMount || disk.lastMount.hostId !== hostId) return false;
    if (!pathOnMount(disk.lastMount.mountPoint, savePath, os)) return false;
    const root = volumeRoot(os, disk.lastMount.mountPoint);
    const taken = disks.some(
      (other) =>
        other.online &&
        other.mounts.some((mount) => mount.hostId === hostId && volumeRoot(os, mount.mountPoint) === root),
    );
    return !taken;
  });

  if (offline.length === 1) return slotOfDisk(offline[0]!);

  const root = volumeRoot(os, savePath);
  const ambiguous = offline.length > 1;
  return {
    key: `fallback:${hostId}:${root}`,
    label: `Хост ${hostId} · том ${root}`,
    mode: "fallback",
    diskId: null,
    online: true,
    filesystem: null,
    note: ambiguous
      ? `Несколько отключённых дисков помнят путь ${root}. Слияния нет: временный слот — хост и корень тома, не серийный номер.`
      : `Каталог не сопоставил путь с серийным номером и UUID. Временный слот: хост + корень тома (${root}). Буква диска не становится личностью диска.`,
  };
}

export function asSlotDisk(disk: DiskRecord): SlotDisk {
  return {
    id: disk.id,
    label: disk.label,
    filesystem: disk.filesystem,
    online: disk.online,
    mounts: disk.mounts,
    lastMount: disk.lastMount,
  };
}
