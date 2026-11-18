import { FORBIDDEN_WINDOWS_LETTERS, VIRTUAL_ALCOHOL_LABEL, VIRTUAL_WINDOWS_LETTER } from "@/lib/policies/storage-roles";

/** Windows Z: is never opened. E: is the same for every live probe. Config cannot put either back. */
export const IGNORED_WINDOWS_LETTER = "Z";
export const IGNORED_WINDOWS_LETTERS = FORBIDDEN_WINDOWS_LETTERS;
export { VIRTUAL_ALCOHOL_LABEL, VIRTUAL_WINDOWS_LETTER };

export function letterKey(value: string | null | undefined): string {
  const text = String(value ?? "").trim().replace(":", "").toUpperCase();
  return /^[A-Z]$/.test(text) ? text : "";
}

/** Drive letter of a Windows path, including `\\?\E:\`. Empty when the text is not a drive path. */
export function mountLetter(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  const device = /^(?:\\\\\?\\)?([A-Za-z]):/.exec(text);
  if (device) return device[1]!.toUpperCase();
  return letterKey(text);
}

export function isIgnoredLetter(value: string | null | undefined): boolean {
  const letter = letterKey(value) || mountLetter(value);
  return letter === "E" || letter === "Z";
}

export function isVirtualAlcoholLetter(value: string | null | undefined): boolean {
  const letter = letterKey(value) || mountLetter(value);
  return letter === VIRTUAL_WINDOWS_LETTER;
}

export function isIgnoredMount(path: string | null | undefined): boolean {
  return isIgnoredLetter(mountLetter(path));
}

export function isVirtualAlcoholMount(path: string | null | undefined): boolean {
  return isVirtualAlcoholLetter(mountLetter(path));
}

export function isIgnoredVolume(volume: {
  letter?: string | null;
  mountPaths?: readonly string[];
  lastMountPath?: string | null;
}): boolean {
  if (isIgnoredLetter(volume.letter)) return true;
  const paths = [...(volume.mountPaths ?? []), volume.lastMountPath ?? ""];
  return paths.some((item) => isIgnoredMount(item));
}

export function isVirtualAlcoholVolume(volume: {
  letter?: string | null;
  mountPaths?: readonly string[];
  lastMountPath?: string | null;
}): boolean {
  if (isVirtualAlcoholLetter(volume.letter)) return true;
  const paths = [...(volume.mountPaths ?? []), volume.lastMountPath ?? ""];
  return paths.some((item) => isVirtualAlcoholMount(item));
}

/** WizTree MFT import and a catalog row that was never a live scan. */
export function isOfflineSnapshot(disk: { snapshotOnly?: boolean; lastHostId?: string | null }): boolean {
  return disk.snapshotOnly === true || disk.lastHostId === "offline-snapshot";
}

/**
 * Live E: and Z: are not catalog disks. An offline snapshot of those letters may stay:
 * mft-import still rejects a new E export, and Z is stored only as snapshotOnly.
 */
export function excludedFromCatalog(disk: {
  snapshotOnly?: boolean;
  lastHostId?: string | null;
  letter?: string | null;
  mountPaths?: readonly string[];
  lastMountPath?: string | null;
}): boolean {
  if (isOfflineSnapshot(disk)) return false;
  return isIgnoredVolume(disk);
}
