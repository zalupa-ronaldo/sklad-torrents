import type { IndexSource } from "@/addons/media-games/file-index/types";

/** Badge text in the Media & Games search results. Mac walks never say MFT. */
export function sourceBadgeLabel(source: IndexSource): "MFT" | "USN" | "обход папок" {
  if (source === "mft") return "MFT";
  if (source === "usn") return "USN";
  return "обход папок";
}
