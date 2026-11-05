import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEMO_HASH, DEMO_MAC_ID, DEMO_PC_ID } from "@/lib/qbittorrent/demo-data";
import { startFakeQbittorrent, type FakeQbittorrent } from "@/lib/qbittorrent/fake-server";
import { resetMockStateForTests } from "@/lib/qbittorrent/mock-client";
import {
  addTorrent,
  createHost,
  deleteTorrent,
  getDashboard,
  getTorrentDetail,
  markForMove,
  pauseTorrent,
  relocateTorrent,
  resetDemo,
  resumeTorrent,
  skipIncomplete,
  testHost,
  updateHost,
} from "@/lib/qbittorrent/service";

describe("torrent service", () => {
  let dir: string;
  const servers: FakeQbittorrent[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-"));
    process.env.SKLAD_DATA_DIR = dir;
    resetMockStateForTests();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("lists both demo hosts and the folder each torrent lives in", async () => {
    const dashboard = await getDashboard();
    expect(dashboard.hosts.map((host) => host.id)).toEqual([DEMO_MAC_ID, DEMO_PC_ID]);
    expect(dashboard.hosts.every((host) => host.online)).toBe(true);
    const gow = dashboard.torrents.find((torrent) => torrent.hash === DEMO_HASH.godOfWar);
    expect(gow).toMatchObject({
      hostName: "Mac mini",
      hostOs: "darwin",
      state: "downloading",
      savePath: "/Volumes/vault/PSP/Games/Downloads",
    });
    expect(gow?.progress).toBeGreaterThan(0);
    expect(gow?.progress).toBeLessThan(1);
    const detail = await getTorrentDetail(DEMO_PC_ID, DEMO_HASH.control);
    expect(detail.files.find((file) => file.name.endsWith("pack0.pack"))?.absolutePath).toBe(
      "D:\\Games\\Control Ultimate Edition\\data\\pack0.pack",
    );
    const archive = await getTorrentDetail(DEMO_PC_ID, DEMO_HASH.archive);
    expect(archive.files[1].absolutePath).toBe("E:\\Archive\\Семейный архив 2019\\видео\\день рождения.mp4");
  });

  it("adds a magnet on the demo Mac, pauses it, and keeps the chosen folder", async () => {
    const magnet = `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=PSP%20Demo`;
    const added = await addTorrent({
      hostId: DEMO_MAC_ID,
      urls: magnet,
      savePath: "/Volumes/vault/PSP/Games/Downloads/",
    });
    expect(added.hashes).toEqual(["a".repeat(40)]);
    await pauseTorrent(DEMO_MAC_ID, added.hashes[0]);
    const dashboard = await getDashboard();
    const torrent = dashboard.torrents.find((item) => item.hash === added.hashes[0]);
    expect(torrent).toMatchObject({
      name: "PSP Demo",
      hostId: DEMO_MAC_ID,
      state: "paused",
      savePath: "/Volumes/vault/PSP/Games/Downloads",
    });
    await resumeTorrent(DEMO_MAC_ID, added.hashes[0]);
    const resumed = (await getDashboard()).torrents.find((item) => item.hash === added.hashes[0]);
    expect(resumed?.state).toBe("metadata");
  });

  it("skips incomplete files and then relocates a finished download without dropping it", async () => {
    const skipped = await skipIncomplete(DEMO_MAC_ID, DEMO_HASH.godOfWar);
    expect(skipped.skipped).toBe(2);
    const gow = await getTorrentDetail(DEMO_MAC_ID, DEMO_HASH.godOfWar);
    expect(gow.torrent.state).toBe("seeding");
    expect(gow.torrent.progress).toBe(1);
    expect(gow.files.filter((file) => file.priority === 0).map((file) => file.name)).toEqual([
      "God of War (PSP)/ISO/ULES00157.iso",
      "God of War (PSP)/Cover/back.jpg",
    ]);
    expect(gow.files.find((file) => file.name.endsWith("ULUS10479.iso"))?.priority).toBe(1);

    await markForMove(DEMO_MAC_ID, DEMO_HASH.interstellar, "/Volumes/vault/Cinema/Watched");
    expect((await getDashboard()).torrents.find((torrent) => torrent.hash === DEMO_HASH.interstellar)?.moveMark?.destination).toBe(
      "/Volumes/vault/Cinema/Watched",
    );
    await relocateTorrent(DEMO_MAC_ID, DEMO_HASH.interstellar, "/Volumes/vault/Cinema/Watched");
    const moved = await getTorrentDetail(DEMO_MAC_ID, DEMO_HASH.interstellar);
    expect(moved.torrent.state).toBe("seeding");
    expect(moved.torrent.savePath).toBe("/Volumes/vault/Cinema/Watched");
    expect(moved.torrent.moveMark).toBeNull();
    expect(moved.files[0].absolutePath).toBe("/Volumes/vault/Cinema/Watched/Interstellar.2014.2160p.mkv");
  });

  it("restores demo data and does not leak a real host password", async () => {
    await deleteTorrent(DEMO_MAC_ID, DEMO_HASH.ubuntu, false);
    expect((await getDashboard()).torrents.some((torrent) => torrent.hash === DEMO_HASH.ubuntu)).toBe(false);
    await resetDemo(DEMO_MAC_ID);
    expect((await getDashboard()).torrents.some((torrent) => torrent.hash === DEMO_HASH.ubuntu)).toBe(true);

    const fake = await startFakeQbittorrent({
      appVersion: "v5.1.2",
      webapiVersion: "2.11.4",
      password: "secret-pass",
      torrents: [
        {
          hash: "d".repeat(40),
          name: "From the PC",
          state: "uploading",
          progress: 1,
          size: 10,
          save_path: "D:\\Downloads",
          content_path: "D:\\Downloads\\From the PC",
        },
      ],
    });
    servers.push(fake);
    const created = await createHost({
      name: "Настоящий ПК",
      baseUrl: `${fake.url}/api/v2`,
      username: "admin",
      password: "secret-pass",
      os: "win32",
      pathPresets: [{ id: "dl", label: "Загрузки", path: "D:\\Downloads" }],
    });
    const dashboard = await getDashboard();
    expect(JSON.stringify(dashboard)).not.toContain("secret-pass");
    const host = dashboard.hosts.find((item) => item.id === created.id);
    expect(host).toMatchObject({ online: true, appVersion: "v5.1.2", baseUrl: fake.url });
    expect(dashboard.torrents.find((torrent) => torrent.name === "From the PC")).toMatchObject({
      hostId: created.id,
      state: "seeding",
      savePath: "D:\\Downloads",
    });
    await updateHost(created.id, {
      name: "Настоящий ПК",
      baseUrl: fake.url,
      username: "admin",
      password: "",
      os: "win32",
      pathPresets: [{ id: "dl", label: "Загрузки", path: "D:\\Downloads" }],
    });
    await expect(testHost({ id: created.id })).resolves.toMatchObject({ appVersion: "v5.1.2" });
  });
});
