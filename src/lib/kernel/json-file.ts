import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/qbittorrent/store";

export function kernelPath(name: string): string {
  return path.join(dataDir(), name);
}

export async function readJsonFile<T>(name: string): Promise<T | null> {
  try {
    const text = await readFile(kernelPath(name), "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonFile(name: string, data: unknown): Promise<void> {
  const file = kernelPath(name);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
