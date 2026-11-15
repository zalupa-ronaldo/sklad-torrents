/** Windows drive Z is never opened, listed, or indexed. Config cannot put it back. */
export const IGNORED_WINDOWS_LETTER = "Z";

export function letterKey(value: string | null | undefined): string {
  const text = String(value ?? "").trim().replace(":", "").toUpperCase();
  return /^[A-Z]$/.test(text) ? text : "";
}

export function isIgnoredLetter(value: string | null | undefined): boolean {
  return letterKey(value) === IGNORED_WINDOWS_LETTER;
}

export function isIgnoredMount(path: string | null | undefined): boolean {
  const text = String(path ?? "").trim();
  if (!text) return false;
  if (isIgnoredLetter(text)) return true;
  return isIgnoredLetter(text.slice(0, 2));
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
