import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { dataDir } from "@/lib/qbittorrent/store";

export function dataFile(name: string): string {
  return path.join(dataDir(), name);
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new QbittorrentError("api", "Не удалось прочитать локальные настройки Склада.");
  }
}

export async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
