import type { QbittorrentClient } from "@/lib/qbittorrent/client";
import { HttpQbittorrentClient } from "@/lib/qbittorrent/http-client";
import { getMockClient, resetMockHost } from "@/lib/qbittorrent/mock-client";
import { QbittorrentError, errorMessage } from "@/lib/qbittorrent/errors";
import {
  assertAllowedTorrentPath,
  assertHash,
  assertPriority,
  assertSavePath,
  describeTorrentLocation,
  isClosedDrive,
  isForbiddenTorrentVolume,
  joinRemotePath,
  pathForWindowsPanel,
} from "@/lib/qbittorrent/paths";
import { downloadPhase } from "@/lib/scheduler/phase";
import { setUserPaused } from "@/lib/scheduler/store";
import {
  createHost,
  dataDir,
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
import { createTransferJob, type TransferJob } from "@/lib/torrents/transfer";

export function requireHost(id: string) {
  return loadRequiredHost(id);
}
import type {
  AddTorrentInput,
  DashboardPayload,
  HostOs,
  HostRecord,
  QbProbe,
  TorrentDetailPayload,
  TorrentFileSnapshot,
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
  const visible = results.map((result) => ({
    ...result,
    torrents: result.torrents.filter(
      (torrent) => !isForbiddenTorrentVolume(torrent.savePath) && !isForbiddenTorrentVolume(torrent.contentPath),
    ),
  }));
  const torrents = visible.flatMap((result) => result.torrents.map((torrent) => decorate(torrent, result.host, marks)));
  torrents.sort((a, b) => a.hostName.localeCompare(b.hostName, "ru") || a.name.localeCompare(b.name, "ru"));
  return {
    hosts: visible.map((result) => ({
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
  const torrent = (await client.listTorrents()).map((item) => forPanel(host, item)).find((item) => item?.hash === safe);
  if (!torrent) throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  const files = await client.listFiles(safe);
  const marks = await loadMarks();
  return {
    torrent: decorate(torrent, host, marks),
    files: files.map((file) => ({
      ...file,
      absolutePath: joinRemotePath(host.os, torrent.savePath, file.name),
    })),
    location: describeTorrentLocation(torrent.savePath, torrent.contentPath),
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
  assertAllowedTorrentPath(input.savePath);
  const savePath = assertSavePath(host.os, host.pathStyle, input.savePath);
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
  assertAllowedTorrentPath(location);
  const next = assertSavePath(host.os, host.pathStyle, location);
  const safe = assertHash(hash);
  const client = clientFor(host);
  const torrents = await client.listTorrents();
  const torrent = torrents.find((item) => item.hash === safe);
  if (!torrent) throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  if (next === torrent.savePath) {
    throw new QbittorrentError("validation", "Это уже текущий каталог.");
  }
  await client.setLocation([safe], next);
  await removeMark(hostId, safe);
}

export async function markForMove(hostId: string, hash: string, destination: string): Promise<void> {
  const host = await requireHost(hostId);
  assertAllowedTorrentPath(destination);
  const path = assertSavePath(host.os, host.pathStyle, destination);
  const safe = assertHash(hash);
  const client = clientFor(host);
  const torrents = await client.listTorrents();
  if (!torrents.some((torrent) => torrent.hash === safe)) {
    throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  }
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

export async function startTorrentTransfer(
  hostId: string,
  hash: string,
  destination: string,
  dir = dataDir(),
): Promise<TransferJob> {
  const host = await requireHost(hostId);
  const safe = assertHash(hash);
  assertAllowedTorrentPath(destination);
  const destRoot = assertSavePath(host.os, host.pathStyle, destination);
  const client = clientFor(host);
  await client.login();
  const torrent = (await client.listTorrents()).find((item) => item.hash === safe);
  if (!torrent) throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  if (torrent.progress < 1) {
    throw new QbittorrentError("validation", "Раздача ещё качается. Перенос начнётся после полной загрузки.");
  }
  const files = await client.listFiles(safe);
  if (files.length === 0) {
    throw new QbittorrentError("validation", "В раздаче нет файлов для переноса.");
  }
  return createTransferJob(
    dir,
    {
      hostId: host.id,
      hash: safe,
      name: torrent.name,
      sourceRoot: torrent.savePath,
      destRoot,
      files: buildTransferFiles(torrent, files, destRoot),
    },
    Date.now(),
  );
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
    const [listed, probe] = await Promise.all([
      client.listTorrents(),
      client.probe().catch(() => null),
    ]);
    const torrents = listed.flatMap((torrent) => {
      const shown = forPanel(host, torrent);
      return shown ? [shown] : [];
    });
    return { host, torrents, probe, error: null };
  } catch (error) {
    return { host, torrents: [], probe: null, error: errorMessage(error) };
  }
}

function forPanel(host: HostRecord, torrent: TorrentSnapshot): TorrentSnapshot | null {
  if (isClosedDrive(torrent.savePath) || isClosedDrive(torrent.contentPath)) return null;
  if (host.os !== "win32") return torrent;
  return {
    ...torrent,
    savePath: pathForWindowsPanel(torrent.savePath),
    contentPath: pathForWindowsPanel(torrent.contentPath),
  };
}

function buildTransferFiles(
  torrent: TorrentSnapshot,
  files: TorrentFileSnapshot[],
  destRoot: string,
): { relativeName: string; size: number; sourcePath: string; destPath: string }[] {
  if (files.length === 1) {
    const file = files[0];
    const sourcePath = torrent.contentPath.trim() || joinUnder(torrent.savePath, file.name);
    return [
      {
        relativeName: file.name,
        size: file.size,
        sourcePath,
        destPath: joinUnder(destRoot, file.name),
      },
    ];
  }
  return files.map((file) => ({
    relativeName: file.name,
    size: file.size,
    sourcePath: joinUnder(torrent.savePath, file.name),
    destPath: joinUnder(destRoot, file.name),
  }));
}

function joinUnder(root: string, child: string): string {
  const os: HostOs = looksLikeWindows(root) ? "win32" : "darwin";
  return joinRemotePath(os, root, child);
}

function looksLikeWindows(input: string): boolean {
  const trimmed = input.trim().replace(/^\\\\\?\\/, "");
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
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
