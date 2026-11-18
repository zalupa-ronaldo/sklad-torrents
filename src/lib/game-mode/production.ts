import { getDashboard, pauseTorrent, resumeTorrent } from "@/lib/qbittorrent/service";
import type { TorrentDeps } from "@/lib/game-mode/bridge";
import { selectDownloadHashes } from "@/lib/game-mode/torrents";

export function productionTorrentDeps(): TorrentDeps {
  return {
    async downloading() {
      const dashboard = await getDashboard();
      const os = new Map(dashboard.hosts.map((host) => [host.id, host.os]));
      return selectDownloadHashes(
        dashboard.torrents.map((torrent) => ({
          hash: torrent.hash,
          hostOs: os.get(torrent.hostId) ?? "darwin",
          state: torrent.state,
          rawState: torrent.rawState,
          progress: torrent.progress,
        })),
      );
    },
    async pause(hash: string) {
      const dashboard = await getDashboard();
      const torrent = dashboard.torrents.find((item) => item.hash.toLowerCase() === hash);
      if (!torrent) return;
      const host = dashboard.hosts.find((item) => item.id === torrent.hostId);
      if (host?.os !== "win32") return;
      await pauseTorrent(torrent.hostId, hash);
    },
    async resume(hash: string) {
      const dashboard = await getDashboard();
      const torrent = dashboard.torrents.find((item) => item.hash.toLowerCase() === hash);
      if (!torrent) return;
      const host = dashboard.hosts.find((item) => item.id === torrent.hostId);
      if (host?.os !== "win32") return;
      await resumeTorrent(torrent.hostId, hash);
    },
  };
}
