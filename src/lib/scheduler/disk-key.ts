import type { CatalogDisk } from "@/lib/drives/types";
import { normalizeRemotePath } from "@/lib/qbittorrent/paths";
import type { HostOs } from "@/lib/qbittorrent/types";

/**
 * How a save path becomes a physical disk.
 *
 * 1. Catalog match wins. The longest mount prefix for this host and OS maps
 *    to `serial` + `uuid`. Two qBittorrent hosts that share that pair share
 *    one download slot, even when one path is macOS and the other is Windows.
 * 2. Fallback when the catalog has no match. The disk is treated as online:
 *    nothing has reported it missing. The key is stable and includes the host,
 *    so the same volume name on two machines does not collide:
 *    - macOS `/Volumes/<name>/…` → `fallback:<hostId>:volume:<name>`
 *    - macOS any other absolute path (`/Users/…`, `/`) → `fallback:<hostId>:volume:/`
 *      (the boot volume)
 *    - Windows `D:\…` → `fallback:<hostId>:letter:D`
 *    - Windows UNC `\\server\share\…` → `fallback:<hostId>:unc:server/share`
 */
export interface ResolvedDisk {
  key: string;
  label: string;
  online: boolean;
  source: "catalog" | "fallback";
  serial: string | null;
  uuid: string | null;
}

export const FALLBACK_NOTE =
  "Каталог дисков не знает этот путь. Ключ собран из хоста и тома: macOS /Volumes/<имя> или /, Windows — буква диска.";

export function catalogDiskKey(serial: string, uuid: string): string {
  return `disk:${encodeURIComponent(serial)}:${encodeURIComponent(uuid)}`;
}

export function resolveDisk(input: {
  hostId: string;
  hostOs: HostOs;
  savePath: string;
  catalog: CatalogDisk[];
}): ResolvedDisk {
  let best: { disk: CatalogDisk; length: number } | null = null;
  for (const disk of input.catalog) {
    for (const mount of disk.mounts) {
      if (mount.os !== input.hostOs) continue;
      if (mount.hostId && mount.hostId !== input.hostId) continue;
      if (!mountMatches(input.hostOs, input.savePath, mount.path)) continue;
      const length = normalizeRemotePath(input.hostOs, mount.path).length;
      if (!best || length > best.length) best = { disk, length };
    }
  }
  if (best) {
    return {
      key: catalogDiskKey(best.disk.serial, best.disk.uuid),
      label: best.disk.label,
      online: best.disk.online,
      source: "catalog",
      serial: best.disk.serial,
      uuid: best.disk.uuid,
    };
  }
  const fallback = fallbackDisk(input.hostId, input.hostOs, input.savePath);
  return {
    key: fallback.key,
    label: fallback.label,
    online: true,
    source: "fallback",
    serial: null,
    uuid: null,
  };
}

export function fallbackDisk(hostId: string, hostOs: HostOs, savePath: string): { key: string; label: string } {
  const normalized = normalizeRemotePath(hostOs, savePath);
  if (hostOs === "darwin") {
    const volume = normalized.match(/^\/Volumes\/([^/]+)/);
    if (volume) {
      return { key: `fallback:${hostId}:volume:${volume[1]}`, label: volume[1] };
    }
    return { key: `fallback:${hostId}:volume:/`, label: "Системный диск" };
  }
  const letter = normalized.match(/^([A-Za-z]):\\/);
  if (letter) {
    const drive = letter[1].toUpperCase();
    return { key: `fallback:${hostId}:letter:${drive}`, label: `Диск ${drive}` };
  }
  const unc = normalized.match(/^\\\\([^\\]+)\\([^\\]+)/);
  if (unc) {
    return {
      key: `fallback:${hostId}:unc:${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`,
      label: `\\\\${unc[1]}\\${unc[2]}`,
    };
  }
  return { key: `fallback:${hostId}:unknown`, label: "Неизвестный диск" };
}

function mountMatches(os: HostOs, savePath: string, mount: string): boolean {
  const path = normalizeRemotePath(os, savePath);
  const root = normalizeRemotePath(os, mount);
  if (!path || !root) return false;
  if (os === "win32") {
    const left = path.toLowerCase();
    const right = root.toLowerCase();
    if (left === right) return true;
    const prefix = right.endsWith("\\") ? right : `${right}\\`;
    return left.startsWith(prefix);
  }
  if (path === root) return true;
  if (root === "/") return path.startsWith("/");
  return path.startsWith(`${root}/`);
}
