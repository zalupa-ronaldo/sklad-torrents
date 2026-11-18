import { describe, expect, it } from "vitest";

import {
  PanelError,
  assemble,
  demoEnabled,
  fetchJson,
  loadCatalog,
  loadPanel,
  loadingSnapshot,
  mapBrowseEntry,
  mapCopyJob,
  mapDisk,
  mapQueueJob,
  mapSearchHit,
  mapTorrent,
  pcAgentOnline,
} from "../../public/prototype/panel-adapter.js";

const PC_MISSING = "Агент Windows не заявлен.";

function disk(index: number, online = true) {
  const mac = index < 8;
  return {
    id: `disk-${index}`,
    label: `Том ${index}`,
    filesystem: mac ? "APFS" : "NTFS",
    totalBytes: 1_000_000_000_000,
    freeBytes: 100_000_000_000,
    online,
    lastSeenAt: "2026-11-18T12:00:00Z",
    lastHostId: mac ? "mac-mini" : "windows-pc",
    lastHostName: mac ? "Mac mini" : "Windows PC",
    mountPaths: online ? [mac ? `/Volumes/t${index}` : `D:\\t${index}\\`] : [],
    lastMountPath: mac ? `/Volumes/t${index}` : `D:\\t${index}\\`,
    fileCount: index,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function router(routes: Record<string, unknown | Error>) {
  return async (url: string) => {
    const hit = routes[url];
    if (hit instanceof Error) throw hit;
    if (hit === undefined) throw new Error(`нет маршрута ${url}`);
    return jsonResponse(hit);
  };
}

const emptyRoutes = {
  "/api/files/copy": { jobs: [] },
  "/api/jobs?limit=100": { jobs: [] },
  "/api/torrents": { hosts: [], torrents: [] },
  "/api/hosts/link": { state: "up", peers: { "pc-agent": { qbittorrent: "up", handbrake: "up", detail: null }, "mac-local": { qbittorrent: "up", handbrake: "up", detail: null } } },
  "/api/files/destinations": { destinations: [] },
};

describe("panel adapter", () => {
  it("keeps the demo switch in dev only", () => {
    expect(demoEnabled("?demo=1", true)).toBe(true);
    expect(demoEnabled("?demo=1", false)).toBe(false);
    expect(demoEnabled("", true)).toBe(false);
    expect(demoEnabled("?demo=0", true)).toBe(false);
  });

  it("maps seventeen disks without inventing kind or location", () => {
    const raw = Array.from({ length: 17 }, (_, index) => disk(index, index !== 3));
    const snapshot = assemble({
      drives: { disks: raw, agentErrors: [] },
      copies: { jobs: [] },
      jobs: { jobs: [] },
      torrents: { hosts: [], torrents: [] },
      destinations: { destinations: [] },
      channel: emptyRoutes["/api/hosts/link"],
    });
    expect(snapshot.disks).toHaveLength(17);
    expect(snapshot.disks.every((item: { kind: unknown; location: unknown }) => item.kind === null && item.location === null)).toBe(true);
    expect(snapshot.disks[0]).toMatchObject({ id: "disk-0", host: "mac-mini", fs: "APFS", online: true, mount: "/Volumes/t0" });
    expect(snapshot.disks[3]?.online).toBe(false);
    expect(snapshot.hosts.find((host) => host.id === "mac-mini")).toMatchObject({ name: "Mac mini", online: true });
    expect(snapshot.hosts.find((host) => host.id === "windows-pc")).toMatchObject({ name: "Windows PC", online: true });
    expect(snapshot.hosts.find((host) => host.id === "pc-agent")).toMatchObject({ name: "pc-agent", online: true });
    expect(snapshot.history).toEqual([]);
    expect(snapshot.rules).toEqual({});
    expect(snapshot.unavailable).toEqual(expect.arrayContaining(["history", "disk.kind", "disk.location", "rules"]));
  });

  it("marks a drive host offline from agentErrors and a PC agent offline from the channel", () => {
    const snapshot = assemble({
      drives: {
        disks: [{ ...disk(0), online: true }],
        agentErrors: [{ hostId: "mac-mini", hostName: "Mac mini", message: "нет связи с 4371" }],
      },
      copies: { jobs: [] },
      jobs: { jobs: [] },
      torrents: { hosts: [], torrents: [] },
      destinations: { destinations: [] },
      channel: {
        state: "down",
        peers: {
          "pc-agent": { qbittorrent: "down", handbrake: "down", detail: PC_MISSING },
          "mac-local": { qbittorrent: "down", handbrake: "down", detail: null },
        },
      },
    });
    expect(snapshot.hosts.find((host) => host.id === "mac-mini")).toMatchObject({ online: false, error: "нет связи с 4371" });
    expect(snapshot.disks[0]?.online).toBe(false);
    expect(snapshot.hosts.find((host) => host.id === "pc-agent")?.online).toBe(false);
    expect(pcAgentOnline({ peers: { "pc-agent": { detail: "qBittorrent не отвечает." } } })).toBe(true);
  });

  it("does not add the PC agent when the channel request failed", () => {
    const snapshot = assemble({
      drives: { disks: [], agentErrors: [] },
      channel: null,
      channelMissing: true,
      copies: { jobs: [] },
      jobs: { jobs: [] },
      torrents: { hosts: [], torrents: [] },
      destinations: { destinations: [] },
    });
    expect(snapshot.hosts).toEqual([]);
    expect(snapshot.disks).toEqual([]);
    expect(snapshot.unavailable).toContain("pc-agent");
  });

  it("maps a running copy with SHA-256 and a queue job", () => {
    const copy = mapCopyJob({
      id: "copy-1",
      status: "running",
      title: "Копирование · notes.txt",
      bytesDone: 40,
      bytesTotal: 100,
      speed: 10,
      sourceSha256: "abc",
      destSha256: null,
      verified: false,
      error: null,
    });
    expect(copy).toMatchObject({
      id: "copy-1",
      kind: "copy",
      state: "running",
      progress: 40,
      bytesPerSec: 10,
      etaSec: 6,
      host: null,
      progressId: "transfer__copy-1",
      sha256: { source: "abc", verified: false },
    });
    expect((copy as { sha256?: { dest?: string } } | null)?.sha256).not.toHaveProperty("dest");
    const queued = mapQueueJob({
      id: "job-1",
      kind: "index",
      host: "pc-agent",
      state: "queued",
      lastError: null,
      progress: { percent: 0, processedBytes: 0, totalBytes: 10, speed: 0, etaSeconds: null, currentFile: "" },
    });
    expect(queued).toMatchObject({ id: "job-1", title: "index", host: "pc-agent", state: "queued", progress: 0, source: "queue" });
    const failed = mapCopyJob({
      id: "copy-err",
      status: "error",
      title: "Копирование · film.mkv",
      bytesDone: 10,
      bytesTotal: 100,
      speed: 0,
      error: "Диск назначения отключился",
    });
    expect(failed).toMatchObject({ state: "error", error: "Диск назначения отключился", etaSec: null });
  });

  it("maps catalog hits, browse sizes, and torrent rows from returned fields", () => {
    const hit = mapSearchHit({
      diskId: "disk-1",
      name: "Hades",
      path: "/Volumes/t1/Games/Hades",
      categories: ["game"],
      kind: "dir",
    });
    expect(hit).toMatchObject({ diskId: "disk-1", type: "Игра", sizeBytes: null, path: "/Volumes/t1/Games/Hades" });
    expect(mapSearchHit({ diskId: "disk-1", name: "note", path: "/n", categories: ["unknown-cat"] })?.type).toBeNull();
    expect(mapBrowseEntry({ diskId: "disk-1", name: "a.txt", relativePath: "a.txt", displayPath: "/Volumes/t1/a.txt", size: 12, categories: [] })).toMatchObject({
      sizeBytes: 12,
    });
    expect(mapBrowseEntry({ diskId: "disk-1", name: "lost", relativePath: "lost", size: null })?.sizeBytes).toBeNull();
    const torrent = mapTorrent(
      {
        hash: "abc",
        name: "Debian",
        state: "downloading",
        progress: 0.5,
        totalSize: 800,
        dlspeed: 2_000_000,
        upspeed: 0,
        savePath: "/Volumes/t1/Downloads",
        hostId: "qb-mac",
        hostName: "Mac mini",
        category: "",
      },
      [disk(1)],
    );
    expect(torrent).toMatchObject({
      id: "abc",
      state: "down",
      progress: 50,
      sizeBytes: 800,
      down: 2,
      diskId: "disk-1",
      hostId: "qb-mac",
      hostName: "Mac mini",
      rank: null,
    });
    expect(torrent).not.toHaveProperty("kind");
    expect(mapDisk({ id: "", label: "x" })).toBeNull();
    expect(mapDisk({ id: "plain" })).toMatchObject({ label: "plain", sizeBytes: null, freeBytes: null, fs: null, mount: null });
  });

  it("loads the panel and keeps disks when a secondary request fails", async () => {
    const fetchImpl = router({
      "/api/drives": { disks: [disk(0)], agentErrors: [] },
      ...emptyRoutes,
      "/api/torrents": new Error("boom"),
    });
    const snapshot = await loadPanel({ fetchImpl, timeoutMs: 1000 });
    expect(snapshot.disks).toHaveLength(1);
    expect(snapshot.torrents).toEqual([]);
    expect(snapshot.unavailable).toContain("torrents");
    expect(snapshot.loading).toBe(false);
  });

  it("reports HTTP errors, bad JSON, network failures, and timeouts", async () => {
    await expect(fetchJson(async () => jsonResponse({ error: "Полка дисков не ответила." }, 503), "/api/drives", 1000)).rejects.toMatchObject({
      code: "http",
      message: "Полка дисков не ответила.",
      status: 503,
    });
    await expect(fetchJson(async () => ({ ok: true, status: 200, text: async () => "not-json" }), "/api/drives", 1000)).rejects.toMatchObject({
      code: "bad_json",
    });
    await expect(fetchJson(async () => { throw new TypeError("socket"); }, "/api/drives", 1000)).rejects.toMatchObject({ code: "network" });
    const hanging = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    await expect(fetchJson(hanging, "/api/drives", 15)).rejects.toMatchObject({ code: "timeout", message: "Панель не ответила вовремя." });
    await expect(loadPanel({ fetchImpl: async () => jsonResponse({ error: "Полка дисков не ответила." }, 500), timeoutMs: 200 })).rejects.toBeInstanceOf(PanelError);
    const files = await loadCatalog(router({ "/api/drives/search?q=hades&limit=100": { hits: [{ diskId: "disk-1", name: "Hades", path: "/Hades", categories: ["game"] }] } }), {
      q: "hades",
      timeoutMs: 200,
    });
    expect(files[0]?.name).toBe("Hades");
    expect(loadingSnapshot().loading).toBe(true);
    expect(loadingSnapshot().disks).toEqual([]);
  });
});
