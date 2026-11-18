import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LibraryState } from "@/lib/windows-library/types";

export function emptyLibraryState(): LibraryState {
  return {
    volumes: [],
    indexes: [],
    catalog: [],
    games: [],
    jobs: [],
    settings: { fastSsd: null },
    covers: {},
  };
}

export async function loadLibraryState(directory: string): Promise<LibraryState> {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, "windows-library.json"), "utf8")) as Partial<LibraryState>;
    const empty = emptyLibraryState();
    return {
      volumes: Array.isArray(parsed.volumes) ? parsed.volumes : [],
      indexes: Array.isArray(parsed.indexes) ? parsed.indexes : [],
      catalog: Array.isArray(parsed.catalog) ? parsed.catalog : [],
      games: Array.isArray(parsed.games) ? parsed.games : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      settings: parsed.settings?.fastSsd ? { fastSsd: parsed.settings.fastSsd } : empty.settings,
      covers: parsed.covers && typeof parsed.covers === "object" ? parsed.covers : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLibraryState();
    throw error;
  }
}

export async function saveLibraryState(directory: string, state: LibraryState): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "windows-library.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, file);
}
