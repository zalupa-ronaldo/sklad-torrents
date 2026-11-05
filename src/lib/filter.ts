import type { NormalizedState, TorrentView } from "@/lib/qbittorrent/types";

export type StateFilter = "all" | "active" | "seeding" | "paused" | "problem" | "marked";
export type SortKey = "activity" | "name" | "progress" | "size";

const ACTIVITY_RANK: Record<NormalizedState, number> = {
  error: 0,
  missing: 1,
  moving: 2,
  downloading: 3,
  metadata: 4,
  stalled: 5,
  queued: 6,
  paused: 7,
  checking: 8,
  seeding: 9,
  unknown: 10,
};

export function filterTorrents(
  torrents: TorrentView[],
  query: { q?: string; hostId?: string; state?: StateFilter },
): TorrentView[] {
  const needle = query.q?.trim().toLowerCase() ?? "";
  return torrents.filter((torrent) => {
    if (query.hostId && query.hostId !== "all" && torrent.hostId !== query.hostId) return false;
    if (!matchesState(torrent, query.state ?? "all")) return false;
    if (!needle) return true;
    const haystack = [torrent.name, torrent.savePath, torrent.contentPath, torrent.hostName, torrent.category]
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function sortTorrents(torrents: TorrentView[], key: SortKey): TorrentView[] {
  const copy = [...torrents];
  copy.sort((a, b) => {
    if (key === "name") return a.name.localeCompare(b.name, "ru");
    if (key === "progress") return b.progress - a.progress || a.name.localeCompare(b.name, "ru");
    if (key === "size") return b.size - a.size || a.name.localeCompare(b.name, "ru");
    return ACTIVITY_RANK[a.state] - ACTIVITY_RANK[b.state] || a.name.localeCompare(b.name, "ru");
  });
  return copy;
}

function matchesState(torrent: TorrentView, state: StateFilter): boolean {
  switch (state) {
    case "all":
      return true;
    case "active":
      return ["downloading", "metadata", "stalled", "queued", "checking", "moving"].includes(torrent.state);
    case "seeding":
      return torrent.state === "seeding";
    case "paused":
      return torrent.state === "paused";
    case "problem":
      return torrent.state === "error" || torrent.state === "missing";
    case "marked":
      return Boolean(torrent.moveMark);
    default:
      return true;
  }
}
