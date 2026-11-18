import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const HASH = /^[a-f0-9]{40}$/;

export function holdFilePath(directory: string): string {
  return path.join(directory, "game-mode-hold.json");
}

export async function readHoldHashes(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { torrents?: unknown };
    if (!Array.isArray(parsed.torrents)) return [];
    return parsed.torrents.filter((item): item is string => typeof item === "string" && HASH.test(item));
  } catch {
    return [];
  }
}

export async function writeHoldHashes(file: string, hashes: readonly string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ torrents: [...hashes] }), { mode: 0o600 });
  await rename(tmp, file);
}
