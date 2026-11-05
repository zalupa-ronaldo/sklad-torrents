import { joinDisplay } from "@/addons/drives/paths";
import { mountPathsOf, online } from "@/addons/drives/reconcile";
import type { DiskRecord, SearchHit } from "@/addons/drives/types";

export function connectHint(label: string, isOnline: boolean): string | null {
  if (isOnline) return null;
  return `Подключите диск «${label}»`;
}

export function searchDisks(disks: readonly DiskRecord[], query: string, limit = 100): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const disk of disks) {
    const isOnline = online(disk);
    const mount = (isOnline ? mountPathsOf(disk)[0] : disk.lastMountPath) || disk.lastMountPath;
    for (const file of disk.files) {
      if (file.name === "sklad-catalog.json") continue;
      const blob = `${file.name} ${file.relativePath}`.toLowerCase();
      if (!blob.includes(needle)) continue;
      hits.push({
        diskId: disk.id,
        label: disk.label,
        serial: disk.serial,
        volumeUuid: disk.volumeUuid,
        filesystem: disk.filesystem,
        online: isOnline,
        path: joinDisplay(disk.pathStyle, mount, file.relativePath),
        name: file.name,
        kind: file.kind,
        categories: file.categories,
        connectHint: connectHint(disk.label, isOnline),
        reachable: isOnline,
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
