import { describe, expect, it } from "vitest";

import { catalogDiskKey, resolveDisk } from "@/lib/scheduler/disk-key";
import { planDownloads } from "@/lib/scheduler/plan";
import { NEXT_PRIORITY, type PlanInput, type SchedulerTorrent } from "@/lib/scheduler/types";
import type { CatalogDisk } from "@/lib/drives/types";

const MAC = "a".repeat(40);
const OTHER = "b".repeat(40);
const THIRD = "c".repeat(40);
const SEED = "d".repeat(40);
const PC = "e".repeat(40);

function torrent(overrides: Partial<SchedulerTorrent> & Pick<SchedulerTorrent, "hash" | "name" | "savePath">): SchedulerTorrent {
  return {
    hostId: "mac",
    hostName: "Mac",
    hostOs: "darwin",
    state: "downloading",
    rawState: "downloading",
    progress: 0.4,
    userPaused: false,
    ...overrides,
  };
}

function vault(): CatalogDisk {
  return {
    serial: "SN-VAULT",
    uuid: "UUID-VAULT",
    label: "Vault",
    online: true,
    mounts: [{ hostId: "mac", os: "darwin", path: "/Volumes/vault" }],
  };
}

function games(): CatalogDisk {
  return {
    serial: "SN-GAMES",
    uuid: "UUID-GAMES",
    label: "Игры",
    online: true,
    mounts: [{ hostId: "pc", os: "win32", path: "D:\\" }],
  };
}

function plan(overrides: Partial<PlanInput> & Pick<PlanInput, "torrents" | "catalog">) {
  return planDownloads({
    order: {},
    priority: {},
    ...overrides,
  });
}

describe("download scheduler", () => {
  it("keeps only the higher queue item active when two downloads share a disk", () => {
    const disk = vault();
    const key = catalogDiskKey(disk.serial, disk.uuid);
    const first = torrent({ hash: MAC, name: "Первая", savePath: "/Volumes/vault/a" });
    const second = torrent({ hash: OTHER, name: "Вторая", savePath: "/Volumes/vault/b", progress: 0.2 });
    const result = plan({
      torrents: [second, first],
      catalog: [disk],
      order: { [key]: [`mac:${MAC}`, `mac:${OTHER}`] },
    });
    expect(result.pause).toEqual([{ hostId: "mac", hash: OTHER }]);
    expect(result.resume).toEqual([]);
    expect(result.queues).toHaveLength(1);
    expect(result.queues[0]?.active?.hash).toBe(MAC);
    expect(result.queues[0]?.waiting.map((item) => item.hash)).toEqual([OTHER]);
  });

  it("leaves both downloads active when they sit on different disks", () => {
    const result = plan({
      torrents: [
        torrent({ hash: MAC, name: "Фильм", savePath: "/Volumes/vault/Cinema" }),
        torrent({
          hash: PC,
          name: "Игра",
          savePath: "D:\\Games",
          hostId: "pc",
          hostName: "PC",
          hostOs: "win32",
        }),
      ],
      catalog: [vault(), games()],
    });
    expect(result.pause).toEqual([]);
    expect(result.resume).toEqual([]);
    expect(result.queues.map((queue) => queue.active?.hash).sort()).toEqual([MAC, PC].sort());
  });

  it("starts the next queued download when the active one completes and does not touch a seed", () => {
    const disk = vault();
    const key = catalogDiskKey(disk.serial, disk.uuid);
    const finished = torrent({
      hash: MAC,
      name: "Готово",
      savePath: "/Volumes/vault/done",
      state: "seeding",
      rawState: "uploading",
      progress: 1,
    });
    const seed = torrent({
      hash: SEED,
      name: "Сид на паузе",
      savePath: "/Volumes/vault/seed",
      state: "paused",
      rawState: "pausedUP",
      progress: 1,
    });
    const next = torrent({
      hash: OTHER,
      name: "Следующая",
      savePath: "/Volumes/vault/next",
      state: "paused",
      rawState: "pausedDL",
      progress: 0.1,
    });
    const result = plan({
      torrents: [finished, seed, next],
      catalog: [disk],
      order: { [key]: [`mac:${OTHER}`] },
    });
    expect(result.resume).toEqual([{ hostId: "mac", hash: OTHER }]);
    expect(result.pause).toEqual([]);
    expect(result.queues[0]?.seeding.map((item) => item.hash).sort()).toEqual([MAC, SEED].sort());
  });

  it("does not pause a live seed that shares the disk with a download", () => {
    const result = plan({
      torrents: [
        torrent({ hash: MAC, name: "Качается", savePath: "/Volumes/vault/a" }),
        torrent({
          hash: SEED,
          name: "Раздаётся",
          savePath: "/Volumes/vault/b",
          state: "seeding",
          rawState: "uploading",
          progress: 1,
        }),
      ],
      catalog: [vault()],
    });
    expect(result.pause).toEqual([]);
    expect(result.resume).toEqual([]);
    expect(result.queues[0]?.active?.hash).toBe(MAC);
    expect(result.queues[0]?.seeding.map((item) => item.hash)).toEqual([SEED]);
  });

  it("queues everything and starts nothing when the disk is offline", () => {
    const disk = vault();
    disk.online = false;
    disk.label = "Архив";
    const active = torrent({ hash: MAC, name: "Активная", savePath: "/Volumes/vault/a" });
    const waiting = torrent({
      hash: OTHER,
      name: "Ждёт",
      savePath: "/Volumes/vault/b",
      state: "paused",
      rawState: "pausedDL",
      progress: 0.2,
    });
    const result = plan({ torrents: [active, waiting], catalog: [disk] });
    expect(result.resume).toEqual([]);
    expect(result.pause).toEqual([{ hostId: "mac", hash: MAC }]);
    expect(result.queues[0]?.active).toBeNull();
    expect(result.queues[0]?.offlineReason).toBe("Диск «Архив» не подключён");
    expect(result.queues[0]?.waiting.map((item) => item.hash).sort()).toEqual([MAC, OTHER].sort());
  });

  it("lets priority and reorder choose the next torrent without a second active download", () => {
    const disk = vault();
    const key = catalogDiskKey(disk.serial, disk.uuid);
    const active = torrent({ hash: MAC, name: "Сейчас", savePath: "/Volumes/vault/now" });
    const low = torrent({
      hash: OTHER,
      name: "Обычная",
      savePath: "/Volumes/vault/low",
      state: "paused",
      rawState: "pausedDL",
    });
    const high = torrent({
      hash: THIRD,
      name: "Следующим",
      savePath: "/Volumes/vault/high",
      state: "paused",
      rawState: "pausedDL",
      progress: 0.05,
    });
    const ordered = plan({
      torrents: [active, low, high],
      catalog: [disk],
      order: { [key]: [`mac:${MAC}`, `mac:${THIRD}`, `mac:${OTHER}`] },
    });
    expect(ordered.pause).toEqual([]);
    expect(ordered.resume).toEqual([]);
    expect(ordered.queues[0]?.active?.hash).toBe(MAC);
    expect(ordered.queues[0]?.waiting.map((item) => item.hash)).toEqual([THIRD, OTHER]);

    const boosted = plan({
      torrents: [active, low, high],
      catalog: [disk],
      order: { [key]: [`mac:${MAC}`, `mac:${OTHER}`, `mac:${THIRD}`] },
      priority: { [`mac:${THIRD}`]: NEXT_PRIORITY },
    });
    expect(boosted.pause).toEqual([]);
    expect(boosted.resume).toEqual([]);
    expect(boosted.queues[0]?.active?.hash).toBe(MAC);
    expect(boosted.queues[0]?.waiting.map((item) => item.hash)).toEqual([THIRD, OTHER]);

    const finished = torrent({
      hash: MAC,
      name: "Сейчас",
      savePath: "/Volumes/vault/now",
      state: "seeding",
      rawState: "uploading",
      progress: 1,
    });
    const started = plan({
      torrents: [finished, low, high],
      catalog: [disk],
      order: { [key]: [`mac:${MAC}`, `mac:${OTHER}`, `mac:${THIRD}`] },
      priority: { [`mac:${THIRD}`]: NEXT_PRIORITY },
    });
    expect(started.resume).toEqual([{ hostId: "mac", hash: THIRD }]);
    expect(started.pause).toEqual([]);
    expect(started.queues[0]?.waiting.map((item) => item.hash)).toEqual([OTHER]);
  });

  it("shares one slot across qBittorrent hosts that target the same serial and UUID", () => {
    const shared: CatalogDisk = {
      serial: "SN-SHARE",
      uuid: "UUID-SHARE",
      label: "Общий",
      online: true,
      mounts: [
        { hostId: "mac", os: "darwin", path: "/Volumes/share" },
        { hostId: "pc", os: "win32", path: "E:\\Share" },
      ],
    };
    const key = catalogDiskKey(shared.serial, shared.uuid);
    const mac = torrent({ hash: MAC, name: "С Mac", savePath: "/Volumes/share/movie" });
    const pc = torrent({
      hash: PC,
      name: "С Windows",
      savePath: "E:\\Share\\movie",
      hostId: "pc",
      hostName: "PC",
      hostOs: "win32",
      progress: 0.3,
    });
    const result = plan({
      torrents: [mac, pc],
      catalog: [shared],
      order: { [key]: [`mac:${MAC}`, `pc:${PC}`] },
    });
    expect(result.queues).toHaveLength(1);
    expect(result.queues[0]?.diskKey).toBe(key);
    expect(result.pause).toEqual([{ hostId: "pc", hash: PC }]);
    expect(result.resume).toEqual([]);
    expect(result.queues[0]?.active?.hash).toBe(MAC);
  });

  it("does not resume a download the user paused", () => {
    const result = plan({
      torrents: [
        torrent({
          hash: MAC,
          name: "Ручная пауза",
          savePath: "/Volumes/vault/a",
          state: "paused",
          rawState: "pausedDL",
          userPaused: true,
        }),
      ],
      catalog: [vault()],
    });
    expect(result.resume).toEqual([]);
    expect(result.pause).toEqual([]);
    expect(result.queues[0]?.active).toBeNull();
    expect(result.queues[0]?.manual.map((item) => item.hash)).toEqual([MAC]);
  });
});

describe("disk key", () => {
  it("documents the host and volume fallback when the catalog has no match", () => {
    expect(resolveDisk({ hostId: "mac", hostOs: "darwin", savePath: "/Volumes/vault/Cinema", catalog: [] })).toMatchObject({
      key: "fallback:mac:volume:vault",
      label: "vault",
      online: true,
      source: "fallback",
    });
    expect(resolveDisk({ hostId: "mac", hostOs: "darwin", savePath: "/Users/me/Downloads", catalog: [] }).key).toBe(
      "fallback:mac:volume:/",
    );
    expect(resolveDisk({ hostId: "pc", hostOs: "win32", savePath: "D:\\Games\\Control", catalog: [] })).toMatchObject({
      key: "fallback:pc:letter:D",
      label: "Диск D",
      source: "fallback",
    });
    expect(resolveDisk({ hostId: "pc", hostOs: "win32", savePath: "\\\\nas\\media\\Movies", catalog: [] }).key).toBe(
      "fallback:pc:unc:nas/media",
    );
  });

  it("keeps fallback disks on different hosts independent and prefers the catalog", () => {
    const result = plan({
      torrents: [
        torrent({ hash: MAC, name: "Mac", savePath: "/Volumes/vault/a" }),
        torrent({
          hash: PC,
          name: "PC",
          savePath: "D:\\Games",
          hostId: "pc",
          hostName: "PC",
          hostOs: "win32",
        }),
      ],
      catalog: [],
    });
    expect(result.pause).toEqual([]);
    expect(result.queues.map((queue) => queue.diskKey).sort()).toEqual(
      ["fallback:mac:volume:vault", "fallback:pc:letter:D"].sort(),
    );

    const cataloged = resolveDisk({
      hostId: "mac",
      hostOs: "darwin",
      savePath: "/Volumes/vault/Cinema/file.mkv",
      catalog: [vault()],
    });
    expect(cataloged).toMatchObject({
      key: catalogDiskKey("SN-VAULT", "UUID-VAULT"),
      source: "catalog",
      label: "Vault",
    });
  });

  it("uses the longest mount prefix", () => {
    const nested: CatalogDisk = {
      serial: "SN-CINEMA",
      uuid: "UUID-CINEMA",
      label: "Кино",
      online: true,
      mounts: [{ hostId: "mac", os: "darwin", path: "/Volumes/vault/Cinema" }],
    };
    const resolved = resolveDisk({
      hostId: "mac",
      hostOs: "darwin",
      savePath: "/Volumes/vault/Cinema/film.mkv",
      catalog: [vault(), nested],
    });
    expect(resolved.label).toBe("Кино");
    expect(resolved.key).toBe(catalogDiskKey("SN-CINEMA", "UUID-CINEMA"));
  });
});
