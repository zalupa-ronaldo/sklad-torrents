import { downloadPhase } from "@/lib/scheduler/phase";
import type { HostOs, NormalizedState } from "@/lib/qbittorrent/types";

export interface TorrentRow {
  hash: string;
  hostOs: HostOs;
  state: NormalizedState;
  rawState: string;
  progress: number;
}

/** Windows downloads and queued downloads. Seeds, paused items, and Mac hosts stay. */
export function selectDownloadHashes(torrents: readonly TorrentRow[]): string[] {
  const hashes: string[] = [];
  for (const torrent of torrents) {
    if (torrent.hostOs !== "win32") continue;
    const phase = downloadPhase(torrent);
    if (phase !== "active" && phase !== "queued") continue;
    const hash = torrent.hash.toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash) || hashes.includes(hash)) continue;
    hashes.push(hash);
  }
  return hashes;
}

export async function syncWindowsTorrents(
  active: boolean,
  held: readonly string[],
  deps: {
    downloading(): Promise<string[]>;
    pause(hash: string): Promise<unknown>;
    resume(hash: string): Promise<unknown>;
  },
): Promise<{ held: string[]; paused: string[]; resumed: string[] }> {
  if (active) {
    const hashes = await deps.downloading();
    const fresh = hashes.filter((hash) => !held.includes(hash));
    const paused: string[] = [];
    for (const hash of fresh) {
      await deps.pause(hash);
      paused.push(hash);
    }
    return { held: [...held, ...paused], paused, resumed: [] };
  }
  const resumed: string[] = [];
  for (const hash of held) {
    await deps.resume(hash);
    resumed.push(hash);
  }
  return { held: [], paused: [], resumed };
}
