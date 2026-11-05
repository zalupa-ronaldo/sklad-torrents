import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export async function readCatalog(): Promise<CatalogFile | null> {
  try {
    const text = await readFile(catalogFilePath(), "utf8");
    const parsed = JSON.parse(text) as CatalogFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.disks)) {
      throw new DriveError(500, "Каталог полки повреждён.");
    }
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
