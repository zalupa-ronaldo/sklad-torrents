import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { ToolsError } from "@/addons/media-games/errors";
import { defaultToolsConfig } from "@/addons/media-games/defaults";
import type { JobRecord, LibraryRecord, ToolsConfig } from "@/addons/media-games/types";

export function toolsDataDir(): string {
  return process.env.SKLAD_DATA_DIR || path.join(process.cwd(), "data");
}

export async function loadConfig(): Promise<ToolsConfig> {
  const stored = await readJson<ToolsConfig | null>(configPath(), null);
  if (!stored) return defaultToolsConfig();
  return stored;
}

export async function saveConfig(config: ToolsConfig): Promise<void> {
  await writeJson(configPath(), config);
}

export async function loadJobs(): Promise<JobRecord[]> {
  const stored = await readJson<{ jobs: JobRecord[] }>(jobsPath(), { jobs: [] });
  if (!stored || !Array.isArray(stored.jobs)) return [];
  return stored.jobs;
}

export async function saveJobs(jobs: JobRecord[]): Promise<void> {
  await writeJson(jobsPath(), { jobs });
}

export async function loadLibrary(): Promise<LibraryRecord[]> {
  const stored = await readJson<{ library: LibraryRecord[] }>(libraryPath(), { library: [] });
  if (!stored || !Array.isArray(stored.library)) return [];
  return stored.library;
}

export async function saveLibrary(library: LibraryRecord[]): Promise<void> {
  await writeJson(libraryPath(), { library });
}

export async function writeMockMarker(job: JobRecord): Promise<string> {
  const dir = path.join(toolsDataDir(), "mock-markers");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${job.id}.txt`);
  const lines = [
    "runner=mock",
    "spawned=false",
    `output=${job.outputPath ?? ""}`,
    "argv:",
    ...job.plannedArgv,
    "",
  ];
  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}

function configPath(): string {
  return path.join(toolsDataDir(), "tools-config.json");
}

function jobsPath(): string {
  return path.join(toolsDataDir(), "tools-jobs.json");
}

function libraryPath(): string {
  return path.join(toolsDataDir(), "tools-library.json");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(file, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new ToolsError("validation", "Не удалось прочитать data/ для медиа и игр.");
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
