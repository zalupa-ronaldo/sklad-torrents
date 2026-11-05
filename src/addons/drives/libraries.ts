import { defaultToolsConfig } from "@/addons/media-games/defaults";
import { loadHosts } from "@/lib/qbittorrent/store";
import type { LibraryRule, MediaCategory } from "@/addons/drives/types";

export const DEFAULT_LIBRARIES: LibraryRule[] = [
  { prefix: "/Volumes/vault/Downloads", category: "torrent" },
  { prefix: "/Volumes/vault/PSP/Games", category: "game" },
  { prefix: "/Volumes/vault/Cinema", category: "media" },
  { prefix: "/Volumes/vault/Music", category: "media" },
  { prefix: "D:\\Downloads", category: "torrent" },
  { prefix: "D:\\Games", category: "game" },
  { prefix: "E:\\Archive", category: "media" },
  { prefix: "E:\\Archive", category: "torrent" },
];

export function inferCategory(prefix: string, label: string): MediaCategory | null {
  const blob = `${prefix} ${label}`.toLowerCase();
  if (/game|games|игр|psp/.test(blob)) return "game";
  if (/cinema|music|movie|видео|кино|музык|archive|архив/.test(blob)) return "media";
  if (/download|torrent|загруз/.test(blob)) return "torrent";
  return null;
}

export function mergeLibraries(rules: readonly LibraryRule[]): LibraryRule[] {
  const seen = new Set<string>();
  const merged: LibraryRule[] = [];
  for (const rule of rules) {
    const prefix = rule.prefix.trim();
    if (!prefix) continue;
    const key = `${prefix.toLowerCase()}|${rule.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ prefix, category: rule.category });
  }
  return merged;
}

export async function loadLibraries(): Promise<LibraryRule[]> {
  const extra: LibraryRule[] = [];
  try {
    const hosts = await loadHosts();
    for (const host of hosts) {
      for (const preset of host.pathPresets) {
        const category = inferCategory(preset.path, preset.label);
        if (category) extra.push({ prefix: preset.path, category });
      }
    }
    for (const host of defaultToolsConfig().hosts) {
      for (const folder of host.libraryFolders) extra.push({ prefix: folder, category: "game" });
    }
  } catch {
    return DEFAULT_LIBRARIES;
  }
  return mergeLibraries([...DEFAULT_LIBRARIES, ...extra]);
}
