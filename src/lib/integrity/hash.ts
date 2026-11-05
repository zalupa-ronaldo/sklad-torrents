import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface ListedFile {
  relativePath: string;
  size: number;
}

/** Injected in tests. Production uses the filesystem API, which reads logical bytes. */
export interface ByteReader {
  list(): Promise<ListedFile[]>;
  read(relativePath: string, offset: number, length: number): Promise<Uint8Array>;
}

export function sha256Hex(data: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(typeof data === "string" ? data : data);
  return hash.digest("hex");
}

export function treeReader(files: Record<string, Uint8Array>): ByteReader {
  const entries = Object.entries(files)
    .map(([relativePath, bytes]) => ({
      relativePath: normalizeRelative(relativePath),
      bytes,
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    async list() {
      return entries.map((entry) => ({ relativePath: entry.relativePath, size: entry.bytes.byteLength }));
    },
    async read(relativePath, offset, length) {
      const entry = entries.find((item) => item.relativePath === normalizeRelative(relativePath));
      if (!entry) throw new Error(`Нет файла ${relativePath}`);
      const start = Math.max(0, offset);
      const end = Math.min(entry.bytes.byteLength, start + Math.max(0, length));
      return entry.bytes.subarray(start, end);
    },
  };
}

/**
 * Logical file bytes through the filesystem API.
 * NTFS compression does not change what this reads.
 */
export function directoryReader(root: string): ByteReader {
  const resolvedRoot = path.resolve(root);
  return {
    async list() {
      const info = await stat(resolvedRoot);
      if (info.isFile()) {
        return [{ relativePath: path.basename(resolvedRoot), size: info.size }];
      }
      const files: ListedFile[] = [];
      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) {
            const fileInfo = await stat(full);
            files.push({
              relativePath: path.relative(resolvedRoot, full).split(path.sep).join("/"),
              size: fileInfo.size,
            });
          }
        }
      }
      await walk(resolvedRoot);
      files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      return files;
    },
    async read(relativePath, offset, length) {
      const full = resolveInside(resolvedRoot, relativePath);
      const handle = await open(full, "r");
      try {
        const buffer = Buffer.alloc(Math.max(0, length));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, offset));
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

export function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function resolveInside(root: string, relativePath: string): string {
  const full = path.resolve(root, ...normalizeRelative(relativePath).split("/"));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Путь выходит за каталог хэша.");
  }
  return full;
}
