import type { QbittorrentClient } from "@/lib/qbittorrent/client";
import { HttpQbittorrentClient } from "@/lib/qbittorrent/http-client";
import { getMockClient, resetMockHost } from "@/lib/qbittorrent/mock-client";
import { QbittorrentError, errorMessage } from "@/lib/qbittorrent/errors";
import { assertHash, assertPathForOs, assertPriority, joinRemotePath } from "@/lib/qbittorrent/paths";
import { downloadPhase } from "@/lib/scheduler/phase";
import { setUserPaused } from "@/lib/scheduler/store";
import {
  createHost,
  deleteHost,
  loadHosts,
  loadMarks,
  removeMark,
  requireHost as loadRequiredHost,
  saveMark,
  toPublic,
  updateHost,
  type HostDraft,
} from "@/lib/qbittorrent/store";

export function requireHost(id: string) {
  return loadRequiredHost(id);
}
import type {
  AddTorrentInput,
  DashboardPayload,
  HostRecord,
  QbProbe,
  TorrentDetailPayload,
  TorrentSnapshot,
  TorrentView,
} from "@/lib/qbittorrent/types";

const httpClients = new Map<string, { key: string; client: HttpQbittorrentClient }>();

export function clientFor(host: HostRecord): QbittorrentClient {
  if (host.kind === "mock") return getMockClient(host);
  const key = [host.id, host.baseUrl, host.username, host.password].join("\n");
  const cached = httpClients.get(host.id);
  if (cached && cached.key === key) return cached.client;
  const client = new HttpQbittorrentClient(host.baseUrl, host.username, host.password);
  httpClients.set(host.id, { key, client });
  return client;
}

export async function getDashboard(): Promise<DashboardPayload> {
  const hosts = await loadHosts();
  const marks = await loadMarks();
  const results = await Promise.all(hosts.map((host) => loadHost(host)));
  const torrents = results.flatMap((result) =>
    result.torrents.map((torrent) => decorate(torrent, result.host, marks)),
  );
  torrents.sort((a, b) => a.hostName.localeCompare(b.hostName, "ru") || a.name.localeCompare(b.name, "ru"));
  return {
    hosts: results.map((result) => ({
      ...toPublic(result.host),
      online: result.error === null,
      error: result.error,
      appVersion: result.probe?.appVersion ?? null,
      webapiVersion: result.probe?.webapiVersion ?? null,
      torrentCount: result.torrents.length,
    })),
    torrents,
  };
}

export async function getTorrentDetail(hostId: string, hash: string): Promise<TorrentDetailPayload> {
  const safe = assertHash(hash);
  const host = await requireHost(hostId);
  const client = clientFor(host);
  await client.login();
  const torrents = await client.listTorrents();
  const torrent = torrents.find((item) => item.hash === safe);
  if (!torrent) throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  const files = await client.listFiles(safe);
  const marks = await loadMarks();
  return {
    torrent: decorate(torrent, host, marks),
    files: files.map((file) => ({
      ...file,
      absolutePath: joinRemotePath(host.os, torrent.savePath, file.name),
    })),
  };
}

export async function addTorrent(input: {
  hostId: string;
  urls?: string;
  filename?: string;
  data?: Uint8Array;
  savePath: string;
  paused?: boolean;
}): Promise<{ hashes: string[] }> {
  const host = await requireHost(input.hostId);
  const urls = input.urls?.trim();
  if (urls) {
    for (const line of urls.split(/\s+/)) {
      if (line && !line.startsWith("magnet:?")) {
        throw new QbittorrentError("validation", "Магнет должен начинаться с magnet:?");
      }
    }
  }
  if (!urls && !input.data) {
    throw new QbittorrentError("validation", "Нужен магнет или файл .torrent.");
  }
  const savePath = assertPathForOs(host.os, input.savePath);
  const payload: AddTorrentInput = {
    urls: urls || undefined,
    torrent: input.data ? { filename: input.filename || "upload.torrent", data: input.data } : undefined,
    savePath,
    paused: Boolean(input.paused),
  };
  return clientFor(host).add(payload);
}

export async function pauseTorrent(hostId: string, hash: string, options?: { user?: boolean }): Promise<void> {
  const host = await requireHost(hostId);
  const safe = assertHash(hash);
  const client = clientFor(host);
  if (options?.user) {
    const torrent = (await client.listTorrents()).find((item) => item.hash === safe);
    if (torrent) {
      const phase = downloadPhase(torrent);
      if (phase === "active" || phase === "paused" || phase === "queued") await setUserPaused(hostId, safe, true);
    }
  }
  await client.pause([safe]);
}

export async function resumeTorrent(hostId: string, hash: string): Promise<void> {
  const host = await requireHost(hostId);
  const safe = assertHash(hash);
  await setUserPaused(hostId, safe, false);
  await clientFor(host).resume([safe]);
}

export async function deleteTorrent(hostId: string, hash: string, deleteFiles: boolean): Promise<void> {
  const host = await requireHost(hostId);
  const safe = assertHash(hash);
  await clientFor(host).remove([safe], deleteFiles);
  await removeMark(hostId, safe);
}

export async function relocateTorrent(hostId: string, hash: string, location: string): Promise<void> {
  const host = await requireHost(hostId);
  const safe = assertHash(hash);
  const client = clientFor(host);
  const torrents = await client.listTorrents();
  const torrent = torrents.find((item) => item.hash === safe);
  if (!torrent) throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  const next = assertPathForOs(host.os, location);
  if (next === torrent.savePath) {
    throw new QbittorrentError("validation", "Это уже текущий каталог.");
  }
  await client.setLocation([safe], next);
  await removeMark(hostId, safe);
}

export async function markForMove(hostId: string, hash: string, destination: string): Promise<void> {
  const host = await requireHost(hostId);
  const safe = assertHash(hash);
  const client = clientFor(host);
  const torrents = await client.listTorrents();
  if (!torrents.some((torrent) => torrent.hash === safe)) {
    throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  }
  const path = assertPathForOs(host.os, destination);
  await saveMark({ hostId, hash: safe, destination: path, markedAt: Date.now() });
}

export async function unmarkMove(hostId: string, hash: string): Promise<void> {
  await removeMark(hostId, assertHash(hash));
}

export async function setFilePriority(hostId: string, hash: string, fileIds: number[], priority: number): Promise<void> {
  const host = await requireHost(hostId);
  const level = assertPriority(priority);
  if (!Array.isArray(fileIds) || fileIds.length === 0 || fileIds.some((id) => !Number.isInteger(id))) {
    throw new QbittorrentError("validation", "Не выбраны файлы.");
  }
  await clientFor(host).setFilePriority(assertHash(hash), fileIds, level);
}

export async function skipIncomplete(hostId: string, hash: string): Promise<{ skipped: number }> {
  const host = await requireHost(hostId);
  const safe = assertHash(hash);
  const client = clientFor(host);
  const files = await client.listFiles(safe);
  const ids = files.filter((file) => file.priority > 0 && file.progress < 0.999).map((file) => file.index);
  if (ids.length === 0) return { skipped: 0 };
  await client.setFilePriority(safe, ids, 0);
  return { skipped: ids.length };
}

export async function resetDemo(hostId: string): Promise<void> {
  const host = await requireHost(hostId);
  if (host.kind !== "mock") {
    throw new QbittorrentError("validation", "Сброс доступен только для демо-хоста.");
  }
  resetMockHost(host.id, host.os);
}

export async function testHost(input: {
  id?: string;
  baseUrl?: string;
  username?: string;
  password?: string;
}): Promise<QbProbe> {
  if (input.id) {
    const host = await requireHost(input.id);
    if (host.kind === "mock") return clientFor(host).probe();
    const username = input.username?.trim() || host.username;
    const password = input.password && input.password.length > 0 ? input.password : host.password;
    const baseUrl = input.baseUrl?.trim() ? input.baseUrl : host.baseUrl;
    return new HttpQbittorrentClient(baseUrl, username, password).probe();
  }
  if (!input.baseUrl?.trim()) throw new QbittorrentError("validation", "Укажите адрес Web UI.");
  return new HttpQbittorrentClient(input.baseUrl, input.username?.trim() || "", input.password || "").probe();
}

export { createHost, updateHost, deleteHost };
export type { HostDraft };

async function loadHost(host: HostRecord): Promise<{
  host: HostRecord;
  torrents: TorrentSnapshot[];
  probe: QbProbe | null;
  error: string | null;
}> {
  try {
    const client = clientFor(host);
    await client.login();
    const [torrents, probe] = await Promise.all([
      client.listTorrents(),
      client.probe().catch(() => null),
    ]);
    return { host, torrents, probe, error: null };
  } catch (error) {
    return { host, torrents: [], probe: null, error: errorMessage(error) };
  }
}

function decorate(torrent: TorrentSnapshot, host: HostRecord, marks: { hostId: string; hash: string; destination: string; markedAt: number }[]): TorrentView {
  const moveMark = marks.find((mark) => mark.hostId === host.id && mark.hash === torrent.hash) ?? null;
  return {
    ...torrent,
    hostId: host.id,
    hostName: host.name,
    hostOs: host.os,
    moveMark,
  };
}
