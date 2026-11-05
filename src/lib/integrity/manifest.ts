import { normalizeRelative } from "@/lib/integrity/hash";

/** sha256sum text mode: hex, two spaces, relative path. */
export function manifestLine(sha256: string, relativePath: string): string {
  return `${sha256.toLowerCase()}  ${normalizeRelative(relativePath)}`;
}

export function manifestDocument(files: { sha256: string; relativePath: string }[]): string {
  const lines = [...files]
    .filter((file) => file.sha256)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((file) => manifestLine(file.sha256, file.relativePath));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function manifestFilename(torrentName: string): string {
  const safe = torrentName.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "torrent";
  return `${safe}.sha256`;
}
