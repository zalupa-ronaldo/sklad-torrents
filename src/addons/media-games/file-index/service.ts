import { defaultPcHost } from "@/addons/media-games/defaults";
import { demoVolumes, type DemoVolume } from "@/addons/media-games/file-index/demo-volumes";
import { MemoryFileIndex } from "@/addons/media-games/file-index/memory";
import { volumeKey } from "@/addons/media-games/file-index/tree";
import type { IndexHit, IndexStatus } from "@/addons/media-games/file-index/types";

interface Shelf {
  local: MemoryFileIndex;
  remote: IndexStatus[];
}

function shelf(): Shelf {
  const globalShelf = globalThis as typeof globalThis & { __skladNtfsShelf?: Shelf };
  if (!globalShelf.__skladNtfsShelf) {
    globalShelf.__skladNtfsShelf = { local: new MemoryFileIndex(), remote: [] };
  }
  return globalShelf.__skladNtfsShelf;
}

/** The Media & Games Windows host. Mac paths are not sent here. */
export function pcAgentBaseUrl(): string {
  const configured = process.env.SKLAD_PC_AGENT_URL || defaultPcHost().agentUrl || "http://127.0.0.1:4730";
  return configured.replace(/\/$/, "");
}

export async function rebuildFileIndex(id: "all" | DemoVolume["id"] = "all"): Promise<IndexStatus[]> {
  const specs = id === "all" ? demoVolumes() : demoVolumes().filter((volume) => volume.id === id);
  const statuses: IndexStatus[] = [];
  for (const spec of specs) statuses.push(await rebuildOne(spec));
  return statuses;
}

export function fileIndexStatus(): IndexStatus[] {
  const local = shelf().local.status();
  const seen = new Set(local.map((status) => volumeKey(status.volume)));
  return [...local, ...shelf().remote.filter((status) => !seen.has(volumeKey(status.volume)))];
}

export async function searchFileIndex(
  query: string,
  options: { volume?: string; directoriesOnly?: boolean } = {},
): Promise<IndexHit[]> {
  if (fileIndexStatus().length === 0) await rebuildFileIndex("all");
  const store = shelf();
  const hits = store.local.search(query, {
    volume: options.volume,
    directoriesOnly: options.directoriesOnly,
    limit: 80,
  });
  for (const spec of demoVolumes()) {
    if (spec.route !== "pc-agent") continue;
    if (options.volume && volumeKey(options.volume) !== volumeKey(spec.volume)) continue;
    if (store.local.status(spec.volume).length > 0) continue;
    try {
      hits.push(...(await searchAgent(query, spec.volume, options.directoriesOnly)));
    } catch {
      // The Windows card already explains a missing agent. Search still returns the Mac walk.
    }
  }
  hits.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.path.localeCompare(b.path, "ru"));
  return hits.slice(0, 80);
}

async function rebuildOne(spec: DemoVolume): Promise<IndexStatus> {
  if (spec.route === "local") {
    return shelf().local.indexVolume({
      host: spec.host,
      volume: spec.volume,
      os: spec.os,
      filesystem: spec.filesystem,
      elevated: false,
      walkRoot: spec.walkRoot,
    });
  }
  try {
    const status = await buildOnAgent(spec);
    shelf().local.dropVolume(spec.volume);
    rememberRemote(status);
    return status;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "нет соединения";
    forgetRemote(spec.volume);
    return shelf().local.indexVolume({
      host: spec.host,
      volume: spec.volume,
      os: spec.os,
      filesystem: spec.filesystem,
      elevated: false,
      walkRoot: spec.walkRoot,
      notice: `Агент Windows недоступен (${reason}). Индекс MFT недоступен. Результаты получены обходом папок.`,
    });
  }
}

function rememberRemote(status: IndexStatus): void {
  const store = shelf();
  store.remote = [...store.remote.filter((item) => volumeKey(item.volume) !== volumeKey(status.volume)), status];
}

function forgetRemote(volume: string): void {
  const store = shelf();
  store.remote = store.remote.filter((item) => volumeKey(item.volume) !== volumeKey(volume));
}

async function buildOnAgent(spec: DemoVolume): Promise<IndexStatus> {
  return agentJson(`${pcAgentBaseUrl()}/v1/index/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      host: spec.host,
      volume: spec.volume,
      filesystem: spec.filesystem,
      walkRoot: spec.walkRoot,
    }),
  });
}

async function searchAgent(query: string, volume: string, directoriesOnly?: boolean): Promise<IndexHit[]> {
  const url = new URL(`${pcAgentBaseUrl()}/v1/index/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("volume", volume);
  if (directoriesOnly) url.searchParams.set("directories", "1");
  const payload = await agentJson<{ hits?: IndexHit[] }>(url, { method: "GET" });
  return Array.isArray(payload.hits) ? payload.hits : [];
}

async function agentJson<T>(url: string | URL, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(8_000) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "сеть";
    throw new Error(`нет соединения с агентом ПК (${reason})`);
  }
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `агент ответил ${response.status}`);
  return payload as T;
}
