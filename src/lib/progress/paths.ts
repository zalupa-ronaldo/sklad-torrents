/** Volume Z: is never read, scanned, indexed, or logged. */
export function isIgnoredVolume(value: string): boolean {
  const text = value.trim();
  if (/^(?:\\\\\?\\)?[zZ]:[\\/]/.test(text)) return true;
  if (/^\/mnt\/[zZ](?:\/|$)/.test(text)) return true;
  return false;
}

/**
 * Where the file already lives.
 * Null means the path is not a known Mac or Windows disk, so the queue does not invent a network copy.
 */
export function machineOfPath(value: string): "mac-local" | "pc-agent" | null {
  const text = value.trim();
  if (!text || isIgnoredVolume(text)) return null;
  if (/^[a-yA-Y]:[\\/]/.test(text)) return "pc-agent";
  if (/^\\\\[^\\]/.test(text)) return "pc-agent";
  if (/^\/mnt\/[a-yA-Y](?:\/|$)/.test(text)) return "pc-agent";
  if (text.startsWith("/Volumes/") || text.startsWith("/Users/")) return "mac-local";
  return null;
}

export function fileLeaf(value: string): string {
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}
