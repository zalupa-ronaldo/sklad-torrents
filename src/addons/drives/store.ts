import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/qbittorrent/store";
import type { AgentEndpoint, DiskRecord, DriveMode } from "@/addons/drives/types";
import { DriveError } from "@/addons/drives/types";

export interface CatalogFile {
  version: 1;
  seeded: boolean;
  disks: DiskRecord[];
}

export interface AgentConfigFile {
  mode: DriveMode;
  agents: AgentEndpoint[];
}

export function catalogFilePath(): string {
  return path.join(dataDir(), "drives.json");
}

export function agentConfigPath(): string {
  return path.join(dataDir(), "drive-agents.json");
}

// Shared by independently bundled Next route modules; one parsed tree per process.
const catalogCache = ((globalThis as typeof globalThis & { __skladCatalog?: Map<string, { stamp: string; baseStamp: string; file: CatalogFile }> }).__skladCatalog ??= new Map());
export function cacheCatalog(file: CatalogFile): void {
  const entry = catalogCache.get(catalogFilePath());
  if (entry) entry.file = file;
}

export async function readCatalog(): Promise<CatalogFile | null> {
  try {
    const target = catalogFilePath();
    const info = await stat(target);
    const baseStamp = `${info.mtimeMs}:${info.size}`;
    let overlay: { baseStamp?: string; disks?: DiskRecord[] } = {};
    let overlayStamp = "";
    try { const meta = await stat(`${target}.overlay`); overlayStamp = `${meta.mtimeMs}:${meta.size}`; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const stamp = `${baseStamp}|${overlayStamp}`;
    const cached = catalogCache.get(target);
    if (cached?.stamp === stamp) return cached.file;
    const parsed: CatalogFile = cached?.baseStamp === baseStamp ? { ...cached.file, disks: [...cached.file.disks] } : JSON.parse(await readFile(target, "utf8")) as CatalogFile;
    if (overlayStamp) overlay = JSON.parse(await readFile(`${target}.overlay`, "utf8"));
    if (overlay.baseStamp === baseStamp && Array.isArray(overlay.disks)) {
      const changes = new Map(overlay.disks.map((disk) => [disk.id, disk]));
      parsed.disks = parsed.disks.map((disk) => { const replacement = changes.get(disk.id); changes.delete(disk.id); return replacement ?? disk; });
      parsed.disks.push(...changes.values());
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.disks)) {
      throw new DriveError(500, "Каталог полки повреждён.");
    }
    catalogCache.set(target, { stamp, baseStamp, file: parsed });
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof DriveError) throw error;
    throw new DriveError(500, "Не удалось прочитать каталог полки.");
  }
}

export async function writeCatalog(file: CatalogFile): Promise<void> {
  const target = catalogFilePath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file), "utf8");
  await rename(tmp, target);
  const info = await stat(target);
  const baseStamp = `${info.mtimeMs}:${info.size}`;
  catalogCache.set(target, { stamp: `${baseStamp}|`, baseStamp, file });
}

/** Persist a small changed volume without serializing the million-row system disk.
 * Large new snapshots still replace the atomic base; an old overlay is ignored by stamp.
 */
export async function writeCatalogChanges(file: CatalogFile, previous: CatalogFile | null): Promise<void> {
  const changed = file.disks.filter((disk) => previous?.disks.find((old) => old.id === disk.id)?.files !== disk.files);
  if (!previous || changed.some((disk) => disk.files.length > 100_000)) return writeCatalog(file);
  const target = catalogFilePath();
  const info = await stat(target);
  const baseStamp = `${info.mtimeMs}:${info.size}`;
  let old: { baseStamp?: string; disks?: DiskRecord[] } = {};
  try { old = JSON.parse(await readFile(`${target}.overlay`, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const changes = new Map((old.baseStamp === baseStamp ? old.disks ?? [] : []).map((disk) => [disk.id, disk]));
  for (const disk of changed) changes.set(disk.id, disk);
  const tmp = `${target}.overlay.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ baseStamp, disks: [...changes.values()] }), "utf8");
  await rename(tmp, `${target}.overlay`);
  const meta = await stat(`${target}.overlay`);
  catalogCache.set(target, { stamp: `${baseStamp}|${meta.mtimeMs}:${meta.size}`, baseStamp, file });
}

export function defaultAgentConfig(): AgentConfigFile {
  const mode = process.env.SKLAD_DRIVE_MODE === "agents" ? "agents" : "mock";
  const mac = process.env.SKLAD_MAC_AGENT_URL || "http://127.0.0.1:4371";
  const win = process.env.SKLAD_WINDOWS_AGENT_URL || "http://127.0.0.1:4372";
  return {
    mode,
    agents: [
      { id: "mac-mini", name: "Mac mini", os: "darwin", url: mac },
      { id: "windows-pc", name: "Windows PC", os: "win32", url: win },
    ],
  };
}

export async function readAgentConfig(): Promise<AgentConfigFile> {
  const fallback = defaultAgentConfig();
  try {
    const text = await readFile(agentConfigPath(), "utf8");
    const parsed = JSON.parse(text) as Partial<AgentConfigFile>;
    const mode = process.env.SKLAD_DRIVE_MODE === "agents" || process.env.SKLAD_DRIVE_MODE === "mock"
      ? process.env.SKLAD_DRIVE_MODE
      : parsed.mode === "agents"
        ? "agents"
        : fallback.mode;
    const agents = Array.isArray(parsed.agents) && parsed.agents.length > 0 ? parsed.agents.filter(isAgent) : fallback.agents;
    return { mode, agents };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new DriveError(500, "Не удалось прочитать адреса агентов.");
  }
}

function isAgent(value: unknown): value is AgentEndpoint {
  if (!value || typeof value !== "object") return false;
  const agent = value as AgentEndpoint;
  return (
    typeof agent.id === "string" &&
    typeof agent.name === "string" &&
    (agent.os === "darwin" || agent.os === "win32") &&
    typeof agent.url === "string"
  );
}
