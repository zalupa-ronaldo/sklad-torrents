import { filterTorrents, type StateFilter } from "@/lib/filter";
import { describeTorrentLocation, windowsPathToWsl, wslPathToWindows } from "@/lib/qbittorrent/paths";
import type { TorrentView } from "@/lib/qbittorrent/types";

const STATES: readonly StateFilter[] = ["all", "active", "seeding", "paused", "problem", "marked"];

export function searchTorrents(
  torrents: TorrentView[],
  query: { q?: string; hostId?: string; state?: StateFilter | string },
): TorrentView[] {
  const narrowed = filterTorrents(torrents, {
    hostId: query.hostId,
    state: normalizeState(query.state),
    q: "",
  });
  const needle = query.q?.trim().toLowerCase() ?? "";
  if (!needle) return narrowed;
  return narrowed.filter((torrent) => matchesQuery(torrent, needle));
}

function matchesQuery(torrent: TorrentView, needle: string): boolean {
  if (filterTorrents([torrent], { q: needle }).length > 0) return true;
  const location = describeTorrentLocation(torrent.savePath, torrent.contentPath);
  const content = describeTorrentLocation(torrent.contentPath, torrent.contentPath);
  const extras = [
    location.windowsPath,
    location.wslPath,
    content.windowsPath,
    content.wslPath,
    windowsPathToWsl(torrent.savePath),
    wslPathToWindows(torrent.savePath),
    windowsPathToWsl(torrent.contentPath),
    wslPathToWindows(torrent.contentPath),
  ];
  const haystack = extras
    .flatMap((value) => (value ? [value, value.replace(/\\/g, "/"), value.replace(/\//g, "\\")] : []))
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

function normalizeState(state: string | undefined): StateFilter {
  if (!state || state === "all") return "all";
  return (STATES as readonly string[]).includes(state) ? (state as StateFilter) : "all";
}
