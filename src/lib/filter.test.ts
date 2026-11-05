import { describe, expect, it } from "vitest";

import { filterTorrents, sortTorrents } from "@/lib/filter";
import type { TorrentView } from "@/lib/qbittorrent/types";

function torrent(patch: Partial<TorrentView> & Pick<TorrentView, "hash" | "name" | "hostId">): TorrentView {
  return {
    hostName: "Mac mini",
    hostOs: "darwin",
    state: "downloading",
    rawState: "downloading",
    progress: 0.5,
    size: 10,
    totalSize: 10,
    downloaded: 5,
    uploaded: 0,
    dlspeed: 0,
    upspeed: 0,
    eta: 0,
    ratio: 0,
    savePath: "/Volumes/vault/Downloads",
    contentPath: "/Volumes/vault/Downloads/file",
    addedOn: 1,
    completionOn: 0,
    numSeeds: 0,
    numLeechs: 0,
    category: "",
    tags: [],
    moveMark: null,
    ...patch,
  };
}

describe("unified list filters", () => {
  const rows = [
    torrent({
      hash: "1",
      name: "God of War (PSP)",
      hostId: "demo-mac",
      savePath: "/Volumes/vault/PSP/Games/Downloads",
      contentPath: "/Volumes/vault/PSP/Games/Downloads/God of War (PSP)",
      state: "downloading",
    }),
    torrent({
      hash: "2",
      name: "Интерстеллар",
      hostId: "demo-mac",
      state: "seeding",
      rawState: "uploading",
      progress: 1,
      savePath: "/Volumes/vault/Cinema",
    }),
    torrent({
      hash: "3",
      name: "Control",
      hostId: "demo-pc",
      hostName: "Windows PC",
      hostOs: "win32",
      state: "missing",
      rawState: "missingFiles",
      savePath: "E:\\Archive",
    }),
    torrent({
      hash: "4",
      name: "Blender",
      hostId: "demo-pc",
      hostName: "Windows PC",
      hostOs: "win32",
      state: "seeding",
      moveMark: { hostId: "demo-pc", hash: "4", destination: "E:\\Cinema", markedAt: 1 },
    }),
  ];

  it("finds a download by name or by the folder it lives in", () => {
    expect(filterTorrents(rows, { q: "psp" }).map((row) => row.hash)).toEqual(["1"]);
    expect(filterTorrents(rows, { q: "vault/cinema" }).map((row) => row.name)).toEqual(["Интерстеллар"]);
    expect(filterTorrents(rows, { q: "windows" }).map((row) => row.hash).sort()).toEqual(["3", "4"]);
  });

  it("filters by host, problem state and move marks", () => {
    expect(filterTorrents(rows, { hostId: "demo-mac" })).toHaveLength(2);
    expect(filterTorrents(rows, { state: "problem" }).map((row) => row.hash)).toEqual(["3"]);
    expect(filterTorrents(rows, { state: "marked" }).map((row) => row.name)).toEqual(["Blender"]);
  });

  it("sorts active downloads ahead of seeding", () => {
    const sorted = sortTorrents(rows, "activity");
    expect(sorted[0].state).toBe("missing");
    expect(sorted.at(-1)?.state).toBe("seeding");
  });
});
