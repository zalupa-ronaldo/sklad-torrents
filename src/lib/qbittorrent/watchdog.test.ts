import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  disableQbittorrentSupervisor,
  enableQbittorrentSupervisor,
  qbittorrentNoxArgs,
  tickQbittorrentWatchdog,
  tickWatchdog,
  type WatchdogSnapshot,
} from "@/lib/qbittorrent/watchdog";

const fresh = (): WatchdogSnapshot => ({
  status: "down",
  restarts: 0,
  lastError: null,
  checkedAt: 0,
  nextStartAt: 0,
});

describe("qbittorrent watchdog", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-watchdog-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an argv array and rejects spaces or slashes in the account", () => {
    expect(qbittorrentNoxArgs({ distro: "Ubuntu", user: "brokerworker" })).toEqual([
      "wsl.exe",
      "-d",
      "Ubuntu",
      "-u",
      "brokerworker",
      "--",
      "qbittorrent-nox",
    ]);
    expect(() => qbittorrentNoxArgs({ distro: "Ubuntu 22", user: "brokerworker" })).toThrow();
    expect(() => qbittorrentNoxArgs({ distro: "Ubuntu", user: "a/b" })).toThrow();
    expect(() => qbittorrentNoxArgs({ distro: "../x", user: "brokerworker" })).toThrow();
    expect(() => qbittorrentNoxArgs({ distro: "Ubuntu", user: "brokerworker", binary: "bin/qb" })).toThrow();
    expect(() => qbittorrentNoxArgs({ distro: "Ubuntu", user: "brokerworker", binary: "qb\\nox" })).toThrow();
    expect(() => qbittorrentNoxArgs({ distro: "Ubuntu", user: "brokerworker", binary: "qb..nox" })).toThrow();
  });

  it("starts once, then waits 30 seconds before starting again", () => {
    const first = tickWatchdog(fresh(), false, true, 1_000);
    expect(first.shouldStart).toBe(true);
    expect(first.snapshot).toMatchObject({ status: "starting", restarts: 1, nextStartAt: 31_000 });
    const second = tickWatchdog(first.snapshot, false, true, 1_000);
    expect(second.shouldStart).toBe(false);
    expect(second.snapshot.restarts).toBe(1);
    const third = tickWatchdog(second.snapshot, false, true, 31_000);
    expect(third.shouldStart).toBe(true);
    expect(third.snapshot.restarts).toBe(2);
  });

  it("does not start when the host cannot be started", () => {
    const blocked = tickWatchdog(fresh(), false, false, 1_000);
    expect(blocked.shouldStart).toBe(false);
    expect(blocked.snapshot.status).toBe("down");
    expect(blocked.snapshot.lastError).toBe("qBittorrent не ответил. Проверьте, что Web UI запущен.");
    expect(blocked.snapshot.restarts).toBe(0);
  });

  it("stores the deployment account and only starts a WSL host when the supervisor is enabled", async () => {
    const enabled = await enableQbittorrentSupervisor(dir, "demo-pc");
    expect(enabled).toEqual({ enabled: true, distro: "Ubuntu", user: "brokerworker", binary: "qbittorrent-nox" });
    const text = await readFile(path.join(dir, "qb-supervisor.json"), "utf8");
    expect(text).not.toMatch(/password/i);
    let starts = 0;
    const denied = await tickQbittorrentWatchdog("demo-pc", dir, {
      pathStyle: "windows",
      now: 5_000,
      probe: async () => false,
      start: () => {
        starts += 1;
      },
    });
    expect(starts).toBe(0);
    expect(denied.status).toBe("down");
    const failed = await tickQbittorrentWatchdog("demo-pc", dir, {
      pathStyle: "wsl",
      now: 5_000,
      probe: async () => false,
      start: () => {
        throw new Error("wsl.exe ENOENT secret-password");
      },
    });
    expect(failed.status).toBe("error");
    expect(failed.lastError).toBe("Не удалось запустить qbittorrent-nox.");
    expect(JSON.stringify(failed)).not.toContain("secret-password");
    expect(JSON.stringify(failed)).not.toContain("wsl.exe");
    const cooled = await tickQbittorrentWatchdog("demo-pc", dir, {
      pathStyle: "wsl",
      now: 6_000,
      probe: async () => false,
      start: () => {
        starts += 1;
      },
    });
    expect(starts).toBe(0);
    expect(cooled.restarts).toBe(failed.restarts);
    expect((await disableQbittorrentSupervisor(dir, "demo-pc")).enabled).toBe(false);
  });
});
