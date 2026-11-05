import type { CatalogDisk } from "@/lib/drives/types";
import type { HostOs, NormalizedState } from "@/lib/qbittorrent/types";

/** Above this, the queue badge says the torrent is «следующим». */
export const NEXT_PRIORITY = 100;

export interface SchedulerTorrent {
  hostId: string;
  hostName: string;
  hostOs: HostOs;
  hash: string;
  name: string;
  savePath: string;
  state: NormalizedState;
  rawState: string;
  progress: number;
  /** Explicit user pause. The scheduler must not resume it. */
  userPaused: boolean;
}

export interface SchedulerPrefs {
  /** disk key → torrent keys, front of the list is higher in the queue. */
  order: Record<string, string[]>;
  /** torrent key → priority. Higher starts sooner among queued items. */
  priority: Record<string, number>;
  userPaused: string[];
}

export function torrentKey(torrent: { hostId: string; hash: string }): string {
  return `${torrent.hostId}:${torrent.hash}`;
}

export function emptySchedulerPrefs(): SchedulerPrefs {
  return { order: {}, priority: {}, userPaused: [] };
}

export interface QueueTorrentRef {
  key: string;
  hostId: string;
  hash: string;
  name: string;
  hostName: string;
  savePath: string;
  progress: number;
  state: NormalizedState;
  rawState: string;
  priority: number;
}

export interface DiskQueueView {
  diskKey: string;
  label: string;
  online: boolean;
  source: "catalog" | "fallback";
  active: QueueTorrentRef | null;
  waiting: QueueTorrentRef[];
  /** User paused these. They do not auto-start. */
  manual: QueueTorrentRef[];
  seeding: QueueTorrentRef[];
  offlineReason: string | null;
  fallbackNote: string | null;
}

export interface SchedulerTarget {
  hostId: string;
  hash: string;
}

export interface SchedulerPlan {
  pause: SchedulerTarget[];
  resume: SchedulerTarget[];
  queues: DiskQueueView[];
}

export interface PlanInput {
  torrents: SchedulerTorrent[];
  catalog: CatalogDisk[];
  order: Record<string, string[]>;
  priority: Record<string, number>;
}
