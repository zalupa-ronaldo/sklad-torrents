import { createHash } from "node:crypto";

import { torrentDisplayName } from "@/lib/qbittorrent/bencode";
import type { QbittorrentClient } from "@/lib/qbittorrent/client";
import { demoTorrents, type SeedTorrent } from "@/lib/qbittorrent/demo-data";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { assertHash, assertPathForOs, assertPriority, joinRemotePath } from "@/lib/qbittorrent/paths";
import { isDownloadRawState, normalizeState } from "@/lib/qbittorrent/state";
import type { AddTorrentInput, HostOs, QbProbe, TorrentFileSnapshot, TorrentSnapshot } from "@/lib/qbittorrent/types";

interface MockSlot {
  os: HostOs;
  torrents: SeedTorrent[];
}

const globalStore = globalThis as typeof globalThis & { __skladMock?: Map<string, MockSlot> };

function memory(): Map<string, MockSlot> {
  if (!globalStore.__skladMock) globalStore.__skladMock = new Map();
  return globalStore.__skladMock;
}

export function resetMockStateForTests(): void {
  globalStore.__skladMock = new Map();
}

export function resetMockHost(hostId: string, os: HostOs): void {
  memory().set(hostId, { os, torrents: structuredClone(demoTorrents(hostId)) });
}

export function getMockClient(host: { id: string; os: HostOs }): QbittorrentClient {
  const map = memory();
  let slot = map.get(host.id);
  if (!slot) {
    slot = { os: host.os, torrents: structuredClone(demoTorrents(host.id)) };
    map.set(host.id, slot);
  }
  slot.os = host.os;
  return new MockQbittorrentClient(host.id, slot);
}

class MockQbittorrentClient implements QbittorrentClient {
  readonly kind = "mock" as const;
  private authed = false;

  constructor(
    private readonly hostId: string,
    private readonly slot: MockSlot,
  ) {}

  async login(): Promise<void> {
    this.authed = true;
  }

  async probe(): Promise<QbProbe> {
    await this.login();
    if (this.hostId === "demo-pc") {
      return { appVersion: "v4.6.7", webapiVersion: "2.9.3", defaultSavePath: "D:\\Downloads" };
    }
    return { appVersion: "v5.1.2", webapiVersion: "2.11.4", defaultSavePath: "/Volumes/vault/Downloads" };
  }

  async listTorrents(): Promise<TorrentSnapshot[]> {
    await this.login();
    return this.slot.torrents.map((torrent) => this.snapshot(torrent));
  }

  async listFiles(hash: string): Promise<TorrentFileSnapshot[]> {
    await this.login();
    const torrent = this.find(hash);
    return torrent.files.map((file) => ({ ...file }));
  }

  async add(input: AddTorrentInput): Promise<{ hashes: string[] }> {
    await this.login();
    const savePath = assertPathForOs(this.slot.os, input.savePath || "");
    const hashes: string[] = [];
    if (input.urls?.trim()) {
      for (const line of input.urls.split(/\s+/)) {
        if (!line) continue;
        if (!line.startsWith("magnet:?")) {
          throw new QbittorrentError("validation", "Магнет должен начинаться с magnet:?");
        }
        hashes.push(this.addMagnet(line, savePath, Boolean(input.paused)));
      }
    }
    if (input.torrent) {
      hashes.push(this.addFile(input.torrent.filename, input.torrent.data, savePath, Boolean(input.paused)));
    }
    if (hashes.length === 0) {
      throw new QbittorrentError("validation", "Нужен магнет или файл .torrent.");
    }
    return { hashes };
  }

  async pause(hashes: string[]): Promise<void> {
    await this.login();
    for (const hash of this.requireHashes(hashes)) {
      const torrent = this.find(hash);
      torrent.rawState = torrent.progress >= 0.999 ? "pausedUP" : "pausedDL";
      torrent.dlspeed = 0;
      torrent.upspeed = 0;
      refreshDerived(torrent);
    }
  }

  async resume(hashes: string[]): Promise<void> {
    await this.login();
    for (const hash of this.requireHashes(hashes)) {
      const torrent = this.find(hash);
      const complete = torrent.progress >= 0.999 && torrent.size > 0;
      const waitingForMetadata = torrent.files.every((file) => file.size === 0);
      torrent.rawState = complete ? "uploading" : waitingForMetadata ? "metaDL" : "downloading";
      torrent.dlspeed = complete || waitingForMetadata ? 0 : torrent.dlspeed || 1_500_000;
      torrent.upspeed = complete ? torrent.upspeed || 200_000 : torrent.upspeed;
      torrent.eta = complete ? 8_640_000 : 3_600;
      refreshDerived(torrent);
    }
  }

  async remove(hashes: string[], deleteFiles: boolean): Promise<void> {
    await this.login();
    void deleteFiles;
    const wanted = new Set(this.requireHashes(hashes));
    const before = this.slot.torrents.length;
    this.slot.torrents = this.slot.torrents.filter((torrent) => !wanted.has(torrent.hash));
    if (this.slot.torrents.length === before) {
      throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
    }
  }

  async setLocation(hashes: string[], location: string): Promise<void> {
    await this.login();
    const next = assertPathForOs(this.slot.os, location);
    for (const hash of this.requireHashes(hashes)) {
      const torrent = this.find(hash);
      relocate(torrent, this.slot.os, next);
    }
  }

  async setFilePriority(hash: string, fileIds: number[], priority: number): Promise<void> {
    await this.login();
    const level = assertPriority(priority);
    const torrent = this.find(hash);
    if (fileIds.length === 0) throw new QbittorrentError("validation", "Не выбраны файлы.");
    for (const id of fileIds) {
      const file = torrent.files.find((item) => item.index === id);
      if (!file) throw new QbittorrentError("not_found", "Файл не найден в раздаче.");
      file.priority = level;
    }
    refreshDerived(torrent);
  }

  private addMagnet(magnet: string, savePath: string, paused: boolean): string {
    const hash = hashFromMagnet(magnet);
    if (this.slot.torrents.some((torrent) => torrent.hash === hash)) {
      throw new QbittorrentError("api", "Такая раздача уже есть на этом хосте.");
    }
    const name = nameFromMagnet(magnet, hash);
    const torrent = blankTorrent(hash, name, savePath, this.slot.os, paused);
    this.slot.torrents.unshift(torrent);
    refreshDerived(torrent);
    return hash;
  }

  private addFile(filename: string, data: Uint8Array, savePath: string, paused: boolean): string {
    const name = torrentDisplayName(data, filename || "upload.torrent").replace(/[\\/]/g, " ");
    const hash = createHash("sha1").update(data).digest("hex");
    if (this.slot.torrents.some((torrent) => torrent.hash === hash)) {
      throw new QbittorrentError("api", "Такая раздача уже есть на этом хосте.");
    }
    const torrent = blankTorrent(hash, name, savePath, this.slot.os, paused);
    this.slot.torrents.unshift(torrent);
    refreshDerived(torrent);
    return hash;
  }

  private snapshot(torrent: SeedTorrent): TorrentSnapshot {
    refreshDerived(torrent);
    return {
      hash: torrent.hash,
      name: torrent.name,
      state: normalizeState(torrent.rawState),
      rawState: torrent.rawState,
      progress: torrent.progress,
      size: torrent.size,
      totalSize: torrent.totalSize,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      dlspeed: torrent.dlspeed,
      upspeed: torrent.upspeed,
      eta: torrent.eta,
      ratio: torrent.ratio,
      savePath: torrent.savePath,
      contentPath: torrent.contentPath,
      addedOn: torrent.addedOn,
      completionOn: torrent.completionOn,
      numSeeds: torrent.numSeeds,
      numLeechs: torrent.numLeechs,
      category: torrent.category,
      tags: [...torrent.tags],
    };
  }

  private find(hash: string): SeedTorrent {
    const safe = assertHash(hash);
    const torrent = this.slot.torrents.find((item) => item.hash === safe);
    if (!torrent) throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
    return torrent;
  }

  private requireHashes(hashes: string[]): string[] {
    if (hashes.length === 0) throw new QbittorrentError("validation", "Не выбрана раздача.");
    return hashes.map((hash) => assertHash(hash));
  }
}

function refreshDerived(torrent: SeedTorrent): void {
  const wanted = torrent.files.filter((file) => file.priority > 0);
  const selected = wanted.reduce((sum, file) => sum + file.size, 0);
  const total = torrent.files.reduce((sum, file) => sum + file.size, 0);
  const done = wanted.reduce((sum, file) => sum + file.size * clamp01(file.progress), 0);
  torrent.totalSize = total;
  torrent.size = selected > 0 ? selected : total;
  torrent.downloaded = Math.round(done);
  torrent.progress = selected === 0 ? 0 : done / selected;
  const raw = torrent.rawState;
  const sticky =
    /^(paused|stopped)/.test(raw) ||
    raw === "error" ||
    raw === "missingFiles" ||
    raw === "moving" ||
    raw.startsWith("checking") ||
    raw.startsWith("queued");
  if (sticky) {
    if (/^(paused|stopped|queued)/.test(raw)) {
      torrent.dlspeed = 0;
      torrent.upspeed = 0;
    }
    return;
  }
  if (torrent.files.length > 0 && selected > 0 && torrent.progress >= 0.999 && isDownloadRawState(raw)) {
    torrent.rawState = "uploading";
    torrent.dlspeed = 0;
    torrent.eta = 8_640_000;
    if (!torrent.completionOn) torrent.completionOn = Math.floor(Date.now() / 1000);
  }
}

function relocate(torrent: SeedTorrent, os: HostOs, location: string): void {
  if (location === torrent.savePath) return;
  const sep = os === "win32" ? "\\" : "/";
  const old = torrent.savePath;
  torrent.savePath = location;
  if (torrent.contentPath === old || torrent.contentPath.startsWith(`${old}${sep}`)) {
    const rest = torrent.contentPath.slice(old.length).replace(/^[/\\]+/, "");
    torrent.contentPath = rest ? joinRemotePath(os, location, rest) : location;
  } else {
    torrent.contentPath = joinRemotePath(os, location, torrent.name);
  }
}

function blankTorrent(hash: string, name: string, savePath: string, os: HostOs, paused: boolean): SeedTorrent {
  const now = Math.floor(Date.now() / 1000);
  return {
    hash,
    name,
    rawState: paused ? "pausedDL" : "metaDL",
    progress: 0,
    size: 0,
    totalSize: 0,
    downloaded: 0,
    uploaded: 0,
    dlspeed: 0,
    upspeed: 0,
    eta: 8_640_000,
    ratio: 0,
    savePath,
    contentPath: joinRemotePath(os, savePath, name),
    addedOn: now,
    completionOn: 0,
    numSeeds: 0,
    numLeechs: 0,
    category: "",
    tags: [],
    files: [
      {
        index: 0,
        name: `${name}/ожидаются метаданные`,
        size: 0,
        progress: 0,
        priority: 1,
      },
    ],
  };
}

function hashFromMagnet(magnet: string): string {
  const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
  const value = match?.[1] ?? "";
  if (/^[a-f0-9]{40}$/i.test(value)) return value.toLowerCase();
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(value)) {
    const hex = base32ToHex(value);
    if (hex) return hex;
  }
  return createHash("sha1").update(magnet).digest("hex");
}

function nameFromMagnet(magnet: string, hash: string): string {
  const match = magnet.match(/(?:^|[?&])dn=([^&]+)/);
  if (!match) return `Раздача ${hash.slice(0, 8)}`;
  try {
    return decodeURIComponent(match[1].replace(/\+/g, " ")).replace(/[\\/]/g, " ").trim() || `Раздача ${hash.slice(0, 8)}`;
  } catch {
    return `Раздача ${hash.slice(0, 8)}`;
  }
}

function base32ToHex(input: string): string | null {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of input.toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) return null;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  if (bytes.length !== 20) return null;
  return Buffer.from(bytes).toString("hex");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
