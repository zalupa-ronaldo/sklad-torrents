import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEMO_HASH, DEMO_MAC_ID } from "@/lib/qbittorrent/demo-data";
import { resetMockStateForTests } from "@/lib/qbittorrent/mock-client";
import { getDashboard } from "@/lib/qbittorrent/service";
import { tickScheduler } from "@/lib/scheduler/apply";

describe("scheduler tick on demo hosts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-sched-"));
    process.env.SKLAD_DATA_DIR = dir;
    resetMockStateForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("pauses the extra Vault download, leaves seeds, and holds the offline disk", async () => {
    const first = await tickScheduler();
    expect(first.applied.resume).toEqual([]);
    expect(first.applied.pause.map((item) => item.hash)).toEqual([DEMO_HASH.ubuntu, DEMO_HASH.vacation]);
    expect(first.applied.pause.some((item) => item.hash === DEMO_HASH.interstellar)).toBe(false);
    expect(first.applied.pause.some((item) => item.hash === DEMO_HASH.blender)).toBe(false);

    const second = await tickScheduler();
    expect(second.applied.pause).toEqual([]);
    expect(second.applied.resume).toEqual([]);

    const dashboard = await getDashboard();
    const state = (hash: string) => dashboard.torrents.find((torrent) => torrent.hash === hash);
    expect(state(DEMO_HASH.godOfWar)?.state).toBe("downloading");
    expect(state(DEMO_HASH.ubuntu)?.state).toBe("paused");
    expect(state(DEMO_HASH.interstellar)?.state).toBe("seeding");
    expect(state(DEMO_HASH.blender)?.state).toBe("seeding");
    expect(state(DEMO_HASH.soundtrack)?.rawState).toBe("pausedUP");
    expect(state(DEMO_HASH.control)?.state).toBe("downloading");
    expect(state(DEMO_HASH.vacation)?.state).toBe("paused");

    const archive = second.plan.queues.find((queue) => queue.label === "Архив");
    expect(archive?.online).toBe(false);
    expect(archive?.active).toBeNull();
    expect(archive?.offlineReason).toBe("Диск «Архив» не подключён");
    expect(archive?.waiting.some((item) => item.hash === DEMO_HASH.vacation)).toBe(true);

    const vault = second.plan.queues.find((queue) => queue.label === "Vault");
    expect(vault?.active?.hash).toBe(DEMO_HASH.godOfWar);
    expect(vault?.waiting.map((item) => item.hash)).toEqual(expect.arrayContaining([DEMO_HASH.ubuntu, DEMO_HASH.dune]));
    expect(vault?.seeding.map((item) => item.hash)).toContain(DEMO_HASH.interstellar);
    expect(vault?.diskKey).toBe(second.plan.queues.find((queue) => queue.active?.hostId === DEMO_MAC_ID)?.diskKey);
  });
});
