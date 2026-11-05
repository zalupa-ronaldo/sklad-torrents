import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { MediaCategory, RawIndexedFile } from "../../src/addons/drives/types.ts";

function asCategory(value: unknown): MediaCategory | null {
  if (value === "torrent" || value === "game" || value === "media") return value;
  return null;
}

/** Read-only directory walk. A failed read aborts the scan so the previous tree is kept. */
export async function walkTree(root: string): Promise<{ files: RawIndexedFile[]; complete: boolean }> {
  if (!root) return { files: [], complete: false };
  const files: RawIndexedFile[] = [];
  const stack = [""];
  try {
    while (stack.length > 0) {
      const relative = stack.pop() ?? "";
      const absolute = relative ? path.join(root, relative) : root;
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childAbsolute = path.join(absolute, entry.name);
        const info = await lstat(childAbsolute);
        let sidecarCategory: MediaCategory | null = null;
        if (entry.isFile() && entry.name === "sklad-catalog.json" && info.size <= 4096) {
          try {
            const parsed = JSON.parse(await readFile(childAbsolute, "utf8")) as { category?: unknown };
            sidecarCategory = asCategory(parsed.category);
          } catch {
            sidecarCategory = null;
          }
        }
        files.push({
          relativePath: childRelative.replace(/\\/g, "/"),
          name: entry.name,
          kind: info.isDirectory() ? "dir" : "file",
          size: info.isDirectory() ? 0 : info.size,
          mtimeMs: info.mtimeMs,
          sidecarCategory,
        });
        if (info.isDirectory()) stack.push(childRelative);
      }
    }
    return { files, complete: true };
  } catch {
    return { files: [], complete: false };
  }
}
