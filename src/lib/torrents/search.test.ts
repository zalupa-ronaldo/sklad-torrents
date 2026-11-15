import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEMO_HASH, DEMO_PC_ID } from "@/lib/qbittorrent/demo-data";
import { resetMockStateForTests } from "@/lib/qbittorrent/mock-client";
import { getDashboard } from "@/lib/qbittorrent/service";
import { searchTorrents } from "@/lib/torrents/search";

describe("torrent search", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-search-"));
    process.env.SKLAD_DATA_DIR = dir;
    resetMockStateForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("finds a Windows game folder by its WSL path", async () => {
    const dashboard = await getDashboard();
    expect(searchTorrents(dashboard.torrents, {})).toHaveLength(dashboard.torrents.length);
    const found = searchTorrents(dashboard.torrents, { q: "/mnt/d/games", hostId: DEMO_PC_ID });
    expect(found.map((torrent) => torrent.hash).sort()).toEqual([DEMO_HASH.control, DEMO_HASH.cyberpunk].sort());
    expect(found.every((torrent) => torrent.savePath.startsWith("D:\\Games"))).toBe(true);
    expect(searchTorrents(dashboard.torrents, { q: "/mnt/d/games", state: "paused" }).map((torrent) => torrent.name)).toEqual([
      "Cyberpunk 2077",
    ]);
  });
});
