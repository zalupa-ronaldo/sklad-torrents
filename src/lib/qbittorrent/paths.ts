import { QbittorrentError } from "@/lib/qbittorrent/errors";
import type { HostOs, PathStyle, TorrentLocation } from "@/lib/qbittorrent/types";

export type { PathStyle } from "@/lib/qbittorrent/types";

export const FORBIDDEN_VOLUME_MESSAGE = "Диск Z: не используется. Выберите другой каталог.";
export const FORBIDDEN_E_MESSAGE = "Диск E: не используется. Выберите другой каталог.";
export const VIRTUAL_ALCOHOL_PATH_MESSAGE = "F — виртуальный диск Alcohol. Выберите другой каталог.";

const CLOSED_DRIVE = /^(?:\\\\\?\\)?[EeZz]:(?:[\\/]|$)/;
const CLOSED_MOUNT = /^\/mnt\/[ez](?:\/|$)/i;
const VIRTUAL_DRIVE = /^(?:\\\\\?\\)?[Ff]:(?:[\\/]|$)/;
const VIRTUAL_MOUNT = /^\/mnt\/f(?:\/|$)/i;

function driveLetterOf(input: string): string {
  const text = input.trim().replace(/\\/g, "/");
  const windows = /^(?:\/\/\?\/)?([A-Za-z]):/.exec(text);
  if (windows) return windows[1]!.toUpperCase();
  const wsl = /^\/mnt\/([A-Za-z])(?:\/|$)/.exec(text);
  return wsl ? wsl[1]!.toUpperCase() : "";
}

/** E: and Z: are never a torrent path. F: is the virtual Alcohol drive and is not a save path. */
export function isClosedDrive(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (CLOSED_DRIVE.test(trimmed) || VIRTUAL_DRIVE.test(trimmed)) return true;
  const slashed = trimmed.replace(/\\/g, "/");
  return CLOSED_MOUNT.test(slashed) || VIRTUAL_MOUNT.test(slashed);
}

export function closedDriveMessage(input: string): string {
  const letter = driveLetterOf(input);
  if (letter === "E") return FORBIDDEN_E_MESSAGE;
  if (letter === "F") return VIRTUAL_ALCOHOL_PATH_MESSAGE;
  return FORBIDDEN_VOLUME_MESSAGE;
}

export function rejectClosedDrive(input: string): void {
  if (isForbiddenTorrentVolume(input)) {
    throw new QbittorrentError("validation", closedDriveMessage(input));
  }
}

/**
 * `/mnt/d/Downloads` is the path qbittorrent-nox sees. The panel stores `D:\\Downloads`.
 * Returns null when the string is not a WSL drive mount. Letters E, F and Z never convert.
 */
export function windowsPathFromWsl(input: string): string | null {
  const slash = input.trim().replace(/\\/g, "/");
  const match = /^\/mnt\/([a-dA-Dg-yG-Y])(?:\/(.*))?$/.exec(slash);
  if (!match) return null;
  const rest = (match[2] ?? "").replace(/\/+$/, "").replace(/\//g, "\\");
  return rest ? `${match[1].toUpperCase()}:\\${rest}` : `${match[1].toUpperCase()}:\\`;
}

export function pathForWindowsPanel(input: string): string {
  rejectClosedDrive(input);
  const translated = windowsPathFromWsl(input);
  if (!translated) return input;
  rejectClosedDrive(translated);
  return normalizeRemotePath("win32", translated);
}

export function normalizeRemotePath(os: HostOs, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (os === "win32") {
    const unc = trimmed.startsWith("\\\\") || trimmed.startsWith("//");
    let path = trimmed.replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
    if (unc) path = `\\\\${path.replace(/^\\+/, "")}`;
    if (/^[A-Za-z]:\\$/.test(path)) return path;
    return path.replace(/\\+$/, "");
  }
  let path = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

export function joinRemotePath(os: HostOs, base: string, child: string): string {
  const root = normalizeRemotePath(os, base);
  const sep = os === "win32" ? "\\" : "/";
  const relative =
    os === "win32"
      ? child.replace(/\//g, "\\").replace(/^\\+/, "")
      : child.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative) return root;
  if (!root) return relative;
  if (root === "/" || /^[A-Za-z]:\\$/.test(root)) return `${root}${relative}`;
  return `${root}${sep}${relative}`;
}

export function assertPathForOs(os: HostOs, input: string): string {
  rejectClosedDrive(input);
  const panel = os === "win32" ? windowsPathFromWsl(input) : null;
  if (panel) rejectClosedDrive(panel);
  const normalized = normalizeRemotePath(os, panel ?? input);
  rejectClosedDrive(normalized);
  if (!normalized) {
    throw new QbittorrentError("validation", "Укажите каталог назначения.");
  }
  if (os === "darwin" && !normalized.startsWith("/")) {
    throw new QbittorrentError(
      "validation",
      "На macOS путь начинается с /, например /Volumes/vault/PSP/Games/Downloads",
    );
  }
  if (os === "win32" && !/^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")) {
    throw new QbittorrentError("validation", "На Windows путь выглядит как D:\\Downloads");
  }
  return normalized;
}

const HASH_RE = /^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/;

export function assertHash(hash: string): string {
  if (!HASH_RE.test(hash)) {
    throw new QbittorrentError("validation", "Некорректный хеш раздачи.");
  }
  return hash.toLowerCase();
}

export function assertPriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < 0 || priority > 7) {
    throw new QbittorrentError("validation", "Приоритет файла должен быть целым числом от 0 до 7.");
  }
  return priority;
}

export function isForbiddenTorrentVolume(input: string): boolean {
  if (isClosedDrive(input)) return true;
  const slashed = input.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return slashed !== input.trim() && isClosedDrive(slashed);
}

export function assertAllowedTorrentPath(input: string): void {
  if (isForbiddenTorrentVolume(input)) {
    throw new QbittorrentError("validation", closedDriveMessage(input));
  }
}

export function windowsPathToWsl(input: string): string | null {
  if (isForbiddenTorrentVolume(input)) return null;
  const raw = input.trim().replace(/^\\\\\?\\/, "");
  const match = raw.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
  if (!match) return null;
  const letter = match[1].toLowerCase();
  if (letter === "e" || letter === "f" || letter === "z") return null;
  const rest = (match[2] ?? "").replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  return rest ? `/mnt/${letter}/${rest}` : `/mnt/${letter}`;
}

export function wslPathToWindows(input: string): string | null {
  if (isForbiddenTorrentVolume(input)) return null;
  const raw = input.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const match = raw.match(/^\/mnt\/([a-dg-y])(?:\/(.*))?$/i);
  if (!match) return null;
  const letter = match[1].toUpperCase();
  const rest = (match[2] ?? "").replace(/^\/+|\/+$/g, "");
  if (!rest) return `${letter}:\\`;
  return `${letter}:\\${rest.replace(/\//g, "\\")}`;
}

export function describeTorrentLocation(savePath: string, contentPath: string): TorrentLocation {
  return {
    seedingFrom: savePath,
    contentPath,
    windowsPath: windowsFamily(savePath),
    wslPath: wslFamily(savePath),
  };
}

export function assertSavePath(os: HostOs, pathStyle: PathStyle | undefined, input: string): string {
  assertAllowedTorrentPath(input);
  if (pathStyle === "wsl") {
    const fromWindows = windowsPathToWsl(input);
    if (fromWindows) return fromWindows;
    const normalized = normalizeWslMount(input);
    if (normalized) return normalized;
    throw new QbittorrentError("validation", "Для WSL путь выглядит как /mnt/d/Downloads или D:\\Downloads");
  }
  return assertPathForOs(os, input);
}

function windowsFamily(input: string): string | null {
  if (!input || isForbiddenTorrentVolume(input)) return null;
  const fromWsl = wslPathToWindows(input);
  if (fromWsl) return fromWsl;
  const asWsl = windowsPathToWsl(input);
  return asWsl ? wslPathToWindows(asWsl) : null;
}

function wslFamily(input: string): string | null {
  if (!input || isForbiddenTorrentVolume(input)) return null;
  const fromWindows = windowsPathToWsl(input);
  if (fromWindows) return fromWindows;
  const asWindows = wslPathToWindows(input);
  return asWindows ? windowsPathToWsl(asWindows) : null;
}

function normalizeWslMount(input: string): string | null {
  const normalized = normalizeRemotePath("darwin", input);
  const match = normalized.match(/^\/mnt\/([a-y])(?:\/(.*))?$/i);
  if (!match) return null;
  const letter = match[1].toLowerCase();
  const rest = (match[2] ?? "").replace(/^\/+|\/+$/g, "");
  return rest ? `/mnt/${letter}/${rest}` : `/mnt/${letter}`;
}
