import { channelPullUrl } from "@/lib/service/channel";

export interface Av1Lane {
  id: string;
  label: string;
  dir: string;
  currentFile: string | null;
  percent: number | null;
  fps: number | null;
  etaSec: number | null;
  done: number | null;
  total: number | null;
  spaceFreedBytes: number | null;
  errors: string[];
}

export interface Av1Status {
  online: boolean;
  started: false;
  lanes: Av1Lane[];
  error?: string;
}

type FetchLike = (url: string, init: { signal: AbortSignal; cache: "no-store"; headers: { accept: string } }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function av1StatusUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const channel = channelPullUrl(env);
  if (!channel) return null;
  const url = new URL(channel);
  url.pathname = "/v1/av1-status";
  url.search = "";
  return url.toString();
}

function asLane(value: unknown): Av1Lane | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.label !== "string") return null;
  return {
    id: row.id,
    label: row.label,
    dir: typeof row.dir === "string" ? row.dir : "",
    currentFile: typeof row.currentFile === "string" ? row.currentFile : null,
    percent: typeof row.percent === "number" ? row.percent : null,
    fps: typeof row.fps === "number" ? row.fps : null,
    etaSec: typeof row.etaSec === "number" ? row.etaSec : null,
    done: typeof row.done === "number" ? row.done : null,
    total: typeof row.total === "number" ? row.total : null,
    spaceFreedBytes: typeof row.spaceFreedBytes === "number" ? row.spaceFreedBytes : null,
    errors: Array.isArray(row.errors) ? row.errors.filter((item): item is string => typeof item === "string") : [],
  };
}

export function offlineAv1(error?: string): Av1Status {
  return { online: false, started: false, lanes: [], ...(error ? { error } : {}) };
}

export async function pullAv1Status(options: { url?: string | null; fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<Av1Status> {
  const url = options.url === undefined ? av1StatusUrl() : options.url;
  if (!url) return offlineAv1("Адрес агента ПК не задан.");
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) return offlineAv1("Агент ПК не ответил.");
    const body = (await response.json()) as { lanes?: unknown };
    const lanes = Array.isArray(body?.lanes) ? body.lanes.map(asLane).filter((lane): lane is Av1Lane => Boolean(lane)) : [];
    return { online: true, started: false, lanes };
  } catch {
    return offlineAv1("Агент ПК не в сети.");
  } finally {
    clearTimeout(timer);
  }
}
