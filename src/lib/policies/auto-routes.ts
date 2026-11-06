import type { DiskRecord } from "@/addons/drives/types";
import type { ContentKind } from "@/lib/content/types";
import { CONTENT_KINDS } from "@/lib/content/types";
import { emptyRules } from "@/lib/policies/presets";
import type { PolicyRules, TypeRule } from "@/lib/policies/types";
import { online, mountPathsOf } from "@/addons/drives/reconcile";

/** Folder signatures learned from existing libraries — not extensions. */
const FOLDER_SIGNATURES: { kind: ContentKind; folders: string[]; post?: TypeRule["postAction"]; index?: TypeRule["indexProfile"] }[] = [
  { kind: "game", folders: ["games", "игры", "steam", "steamapps", "psp"], post: "compact", index: "ntfs-mft" },
  { kind: "movie", folders: ["cinema", "movies", "видеки", "видео", "videos", "фильмы", "перекодированные"], post: "handbrake", index: "walk" },
  { kind: "series", folders: ["series", "сериалы", "сирики", "мульты", "мультфильмы", "tv shows", "tv-shows"], post: "handbrake", index: "walk" },
  { kind: "music", folders: ["music", "музыка"], post: "none", index: "walk" },
  { kind: "software", folders: ["software", "софт", "programs"], post: "none", index: "walk" },
  { kind: "document", folders: ["documents", "документы", "comics", "комиксы"], post: "none", index: "walk" },
  { kind: "other", folders: ["other", "разное", "downloads", "загрузки"], post: "none", index: "walk" },
];

const INSTALLER_FOLDERS = ["games setup", "installers", "установщики", "setup"];

const EXCLUDED_MOUNT = /(?:^|\\|\/)(z:)|\/system\/volumes\/|\\windows\\|\/windows\/|^\/$|efi|recovery|preboot|iscpreboot|xarts?|hardware|^vm$/i;

export interface DiscoveredRoute {
  kind: ContentKind;
  diskId: string;
  folder: string;
  mountPath: string;
  label: string;
  score: number;
}

function isExcludedDisk(disk: DiskRecord): boolean {
  const mounts = [...mountPathsOf(disk), disk.lastMountPath].filter(Boolean);
  if (mounts.some((path) => /^z:\\/i.test(path) || path.toLowerCase() === "z:")) return true;
  if (mounts.every((path) => EXCLUDED_MOUNT.test(path))) return true;
  const name = `${disk.label} ${disk.volumeName}`.toLowerCase();
  if (/^(efi|recovery|preboot|update|vm|xart|hardware|iscpreboot)$/i.test(disk.label.trim())) return true;
  if (name.includes("system volume")) return true;
  return false;
}

function topFolders(disk: DiskRecord): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of disk.files) {
    const relative = (file.relativePath || "").replace(/\\/g, "/");
    const top = relative.split("/").find(Boolean);
    if (!top) continue;
    const key = top.toLowerCase();
    if (key === "system volume information" || key === "$recycle.bin" || key === "windows") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function matchFolder(top: string, candidates: string[]): string | null {
  const lower = top.toLowerCase();
  for (const candidate of candidates) {
    // Exact top-level folder only — "games setup" is not the Games library.
    if (lower === candidate) return top;
  }
  return null;
}

function filesystemOf(disk: DiskRecord): string {
  return (disk.filesystem || "").toLowerCase();
}

/**
 * Adopt typed folder signatures already present on eligible drives.
 * Ambiguous kinds stay without a diskId — never invent a random route.
 */
export function discoverRoutes(disks: readonly DiskRecord[]): DiscoveredRoute[] {
  const eligible = disks.filter((disk) => !isExcludedDisk(disk));
  const found: DiscoveredRoute[] = [];

  for (const signature of FOLDER_SIGNATURES) {
    const candidates: DiscoveredRoute[] = [];
    for (const disk of eligible) {
      const mountPath = mountPathsOf(disk)[0] || disk.lastMountPath || "";
      if (!mountPath) continue;
      if (/^z:\\/i.test(mountPath)) continue;
      const tops = topFolders(disk);
      let bestFolder: string | null = null;
      let bestCount = 0;
      for (const [top, count] of tops) {
        const matched = matchFolder(top, signature.folders);
        if (!matched) continue;
        if (count > bestCount) {
          bestCount = count;
          bestFolder = matched;
        }
      }
      if (!bestFolder) continue;
      const freeScore = Math.max(0, disk.freeBytes) / 1_000_000_000;
      const onlineBonus = online(disk) ? 50 : 0;
      candidates.push({
        kind: signature.kind,
        diskId: disk.id,
        folder: bestFolder,
        mountPath,
        label: disk.label,
        score: bestCount + freeScore + onlineBonus,
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    // Only adopt when the winner is clearly ahead or alone.
    if (candidates.length === 1) found.push(candidates[0]!);
    else if (candidates.length > 1 && candidates[0]!.score >= candidates[1]!.score * 1.25) found.push(candidates[0]!);
  }

  // Installers share software routing when a dedicated setup folder exists.
  for (const disk of eligible) {
    const mountPath = mountPathsOf(disk)[0] || disk.lastMountPath || "";
    if (!mountPath || /^z:\\/i.test(mountPath)) continue;
    const tops = topFolders(disk);
    for (const [top, count] of tops) {
      if (!matchFolder(top, INSTALLER_FOLDERS)) continue;
      if (!found.some((route) => route.kind === "software")) {
        found.push({
          kind: "software",
          diskId: disk.id,
          folder: top,
          mountPath,
          label: disk.label,
          score: count,
        });
      }
      break;
    }
  }

  return found;
}

export function rulesFromDiscovered(disks: readonly DiskRecord[]): PolicyRules {
  const base = emptyRules();
  const discovered = discoverRoutes(disks);
  const byKind = new Map(discovered.map((route) => [route.kind, route]));
  for (const kind of CONTENT_KINDS) {
    const route = byKind.get(kind);
    const signature = FOLDER_SIGNATURES.find((item) => item.kind === kind);
    if (!route) {
      // Keep folder hint from shelf defaults, but clear disk when ambiguous.
      base[kind] = { ...base[kind], diskId: null, customHostId: "", customPath: "" };
      continue;
    }
    const disk = disks.find((item) => item.id === route.diskId);
    const fs = disk ? filesystemOf(disk) : "";
    let postAction = signature?.post ?? base[kind].postAction;
    let indexProfile = signature?.index ?? base[kind].indexProfile;
    if (postAction === "compact" && fs !== "ntfs") postAction = "none";
    if (indexProfile === "ntfs-mft" && fs !== "ntfs") indexProfile = "walk";
    base[kind] = {
      ...base[kind],
      diskId: route.diskId,
      folder: route.folder,
      customHostId: "",
      customPath: "",
      postAction,
      indexProfile,
    };
  }
  return base;
}

export function isShelfDiskUseful(disk: {
  label: string;
  lastMountPath: string;
  mountPaths?: string[];
  fileCount: number;
  totalBytes: number;
  freeBytes: number;
  online: boolean;
}): boolean {
  const mounts = [...(disk.mountPaths ?? []), disk.lastMountPath].filter(Boolean);
  if (mounts.some((path) => /^z:\\/i.test(path))) return false;
  if (mounts.every((path) => EXCLUDED_MOUNT.test(path))) return false;
  if (/^(efi|recovery|preboot|update|vm|xart|hardware|iscpreboot|macintosh hd)$/i.test(disk.label.trim())) return false;
  if (disk.totalBytes > 0 && disk.totalBytes < 8_000_000_000 && disk.fileCount === 0) return false;
  return disk.fileCount > 0 || disk.online || disk.totalBytes >= 50_000_000_000;
}
