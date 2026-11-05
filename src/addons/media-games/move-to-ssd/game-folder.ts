import { parentPathOf } from "@/addons/media-games/file-index/tree";
import type { IndexHit } from "@/addons/media-games/file-index/types";

/** A search hit becomes the game directory the move wizard copies from. */
export function gameFolderFromHit(hit: Pick<IndexHit, "path" | "isDirectory">): string {
  if (hit.isDirectory) return hit.path;
  return parentPathOf(hit.path);
}

export function suggestSsdDestination(sourcePath: string): string {
  const parts = sourcePath.split(/[/\\]/).filter(Boolean);
  const name = parts[parts.length - 1] || "Game";
  if (sourcePath.includes("\\") || /^[A-Za-z]:/.test(sourcePath)) {
    return `C:\\Games\\${name}`;
  }
  return `/Volumes/SSD/Games/${name}`;
}
