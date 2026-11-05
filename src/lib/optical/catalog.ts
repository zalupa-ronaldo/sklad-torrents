import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/qbittorrent/store";
import type { BurnedDisc } from "@/lib/optical/media";

interface DiscFile {
  version: 1;
  discs: BurnedDisc[];
}

function discsPath(): string {
  return path.join(dataDir(), "optical-discs.json");
}

function isDisc(value: unknown): value is BurnedDisc {
  if (!value || typeof value !== "object") return false;
  const disc = value as BurnedDisc;
  return typeof disc.id === "string" && (disc.source === "mock" || disc.source === "tool") && Array.isArray(disc.files);
}

export async function listDiscs(): Promise<BurnedDisc[]> {
  try {
    const text = await readFile(discsPath(), "utf8");
    const parsed = JSON.parse(text) as Partial<DiscFile>;
    if (!parsed || !Array.isArray(parsed.discs)) return [];
    return parsed.discs.filter(isDisc);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function addBurnedDisc(disc: BurnedDisc): Promise<void> {
  const discs = await listDiscs();
  discs.push(disc);
  const file = discsPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: DiscFile = { version: 1, discs };
  await writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
  await rename(tmp, file);
}
