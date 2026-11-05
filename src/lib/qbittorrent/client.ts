import type { AddTorrentInput, QbProbe, TorrentFileSnapshot, TorrentSnapshot } from "@/lib/qbittorrent/types";

export interface QbittorrentClient {
  readonly kind: "mock" | "http";
  login(): Promise<void>;
  probe(): Promise<QbProbe>;
  listTorrents(): Promise<TorrentSnapshot[]>;
  listFiles(hash: string): Promise<TorrentFileSnapshot[]>;
  add(input: AddTorrentInput): Promise<{ hashes: string[] }>;
  pause(hashes: string[]): Promise<void>;
  resume(hashes: string[]): Promise<void>;
  remove(hashes: string[], deleteFiles: boolean): Promise<void>;
  setLocation(hashes: string[], location: string): Promise<void>;
  setFilePriority(hash: string, fileIds: number[], priority: number): Promise<void>;
}
