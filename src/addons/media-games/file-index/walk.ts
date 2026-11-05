import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { IndexError } from "@/addons/media-games/file-index/errors";

export interface WalkItem {
  relativePath: string;
  name: string;
  size: number;
  isDirectory: boolean;
}

const MAX_WALK_ENTRIES = 100_000;

/** Recursive listing. Symlinks are not followed. One unreadable directory does not abort the rest. */
export async function walkDirectory(root: string): Promise<WalkItem[]> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    throw new IndexError("Каталог для обхода недоступен.");
  }
  if (!rootStat.isDirectory()) {
    throw new IndexError("Путь обхода не является каталогом.");
  }

  const items: WalkItem[] = [];
  const stack = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const resolved = path.resolve(current);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "ENOENT") continue;
      throw error;
    }
    for (const dirent of dirents) {
      if (dirent.name === "." || dirent.name === "..") continue;
      if (dirent.isSymbolicLink()) continue;
      const full = path.join(current, dirent.name);
      const isDirectory = dirent.isDirectory();
      let size = 0;
      if (!isDirectory && dirent.isFile()) {
        try {
          size = (await stat(full)).size;
        } catch {
          size = 0;
        }
      }
      items.push({
        relativePath: path.relative(root, full),
        name: dirent.name,
        size,
        isDirectory,
      });
      if (isDirectory) stack.push(full);
      if (items.length > MAX_WALK_ENTRIES) {
        throw new IndexError("Обход остановлен: слишком много файлов.");
      }
    }
  }
  return items;
}
