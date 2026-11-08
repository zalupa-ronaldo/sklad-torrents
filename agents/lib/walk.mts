import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { MediaCategory, RawIndexedFile } from "../../src/addons/drives/types.ts";

function asCategory(value: unknown): MediaCategory | null {
  if (value === "torrent" || value === "game" || value === "media") return value;
  return null;
}

/**
 * Read-only directory walk.
 * One unreadable child (System Volume Information, junctions, locked files) is skipped.
 * The scan fails only when the volume root itself cannot be listed, so the previous tree stays.
 */
export async function walkTree(root: string): Promise<{ files: RawIndexedFile[]; complete: boolean }> {
  if (!root) return { files: [], complete: false };
  const files: RawIndexedFile[] = [];
  const stack = [""];
  try {
    while (stack.length > 0) {
      const relative = stack.pop() ?? "";
      const absolute = relative ? path.join(root, relative) : root;
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch {
        if (!relative) return { files: [], complete: false };
        continue;
      }
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childAbsolute = path.join(absolute, entry.name);
        let info;
        try {
          info = await lstat(childAbsolute);
        } catch {
          continue;
        }
        const link = entry.isSymbolicLink() || info.isSymbolicLink();
        let sidecarCategory: MediaCategory | null = null;
        if (!link && entry.isFile() && entry.name === "sklad-catalog.json" && info.size <= 4096) {
          try {
            const parsed = JSON.parse(await readFile(childAbsolute, "utf8")) as { category?: unknown };
            sidecarCategory = asCategory(parsed.category);
          } catch {
            sidecarCategory = null;
          }
        }
        const directory = !link && info.isDirectory();
        const allocated = !directory && typeof info.blocks === "number" && (info.blocks > 0 || info.size === 0) ? info.blocks * 512 : undefined;
        files.push({
          relativePath: childRelative.replace(/\\/g, "/"),
          name: entry.name,
          kind: directory ? "dir" : "file",
          size: directory ? 0 : info.size,
          ...(allocated != null ? { allocated } : {}),
          mtimeMs: info.mtimeMs,
          sidecarCategory,
        });
        if (directory) stack.push(childRelative);
      }
    }
    return { files, complete: true };
  } catch {
    return { files: [], complete: false };
  }
}
