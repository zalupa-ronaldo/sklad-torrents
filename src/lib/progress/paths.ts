/** Volumes E: and Z: are never read, scanned, indexed, or logged. F: is not a copy path. */
export function isIgnoredVolume(value: string): boolean {
  const text = value.trim();
  if (/^(?:\\\\\?\\)?[eEfFzZ]:[\\/]/.test(text)) return true;
  if (/^\/mnt\/[eEfFzZ](?:\/|$)/.test(text)) return true;
  return false;
}

export function ignoredVolumeDetail(value: string): string {
  const text = value.trim();
  if (/^(?:\\\\\?\\)?[eE]:[\\/]/.test(text) || /^\/mnt\/[eE](?:\/|$)/.test(text)) return "Диск E: не используется.";
  if (/^(?:\\\\\?\\)?[fF]:[\\/]/.test(text) || /^\/mnt\/[fF](?:\/|$)/.test(text)) return "F — виртуальный диск Alcohol.";
  return "Диск Z: не используется.";
}

/**
 * Where the file already lives.
 * Null means the path is not a known Mac or Windows disk, so the queue does not invent a network copy.
 */
export function machineOfPath(value: string): "mac-local" | "pc-agent" | null {
  const text = value.trim();
  if (!text || isIgnoredVolume(text)) return null;
  if (/^[a-dA-Dg-yG-Y]:[\\/]/.test(text)) return "pc-agent";
  if (/^\\\\[^\\]/.test(text)) return "pc-agent";
  if (/^\/mnt\/[a-dA-Dg-yG-Y](?:\/|$)/.test(text)) return "pc-agent";
  if (text.startsWith("/Volumes/") || text.startsWith("/Users/")) return "mac-local";
  return null;
}

export function fileLeaf(value: string): string {
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}
