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
      const categoryNeedles: Record<string,string[]> = { фильм:["media"], фильмы:["media"], кино:["media"], сериал:["series"], сериалы:["series"], игра:["game"], игры:["game"], установщик:["installer"], установщики:["installer"], музыка:["music"], софт:["software"], программы:["software"], документы:["documents"], торрент:["torrent"] };
      const categoryHit = (categoryNeedles[needle] ?? []).some((category) => file.categories.includes(category as never));
      if (!blob.includes(needle) && !categoryHit) continue;
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
