import { describe, expect, it } from "vitest";

import { countActive, emptyPrefs, planScheduler, type SchedTorrent } from "@/lib/kernel/scheduler";
import type { SlotDisk } from "@/lib/kernel/volume";
import { resolveSlot } from "@/lib/kernel/volume";

function torrent(patch: Partial<SchedTorrent> & Pick<SchedTorrent, "hostId" | "hash" | "savePath" | "os">): SchedTorrent {
  return {
    name: patch.hash,
    state: "downloading",
    rawState: "downloading",
    progress: 0.2,
    dlspeed: 1_000_000,
    ...patch,
  };
}

const vault: SlotDisk = {
  id: "vault",
  label: "Vault",
  filesystem: "exfat",
  online: true,
  mounts: [{ hostId: "demo-mac", mountPoint: "/Volumes/vault" }],
  lastMount: { hostId: "demo-mac", mountPoint: "/Volumes/vault" },
};

const games: SlotDisk = {
  id: "games",
  label: "Игры HDD",
  filesystem: "ntfs",
  online: true,
  mounts: [{ hostId: "demo-pc", mountPoint: "D:\\" }],
  lastMount: { hostId: "demo-pc", mountPoint: "D:\\" },
};

describe("download scheduler", () => {
  it("keeps one active download on a disk and a second active on another disk", () => {
    const plans = planScheduler(
      [
        torrent({ hostId: "demo-mac", hash: "gow", name: "God of War", savePath: "/Volumes/vault/PSP", os: "darwin", dlspeed: 8_000_000 }),
        torrent({ hostId: "demo-mac", hash: "ubuntu", name: "Ubuntu", savePath: "/Volumes/vault/Downloads", os: "darwin", state: "stalled", rawState: "stalledDL", dlspeed: 0, progress: 0.12 }),
        torrent({ hostId: "demo-pc", hash: "control", name: "Control", savePath: "D:\\Games", os: "win32" }),
        torrent({ hostId: "demo-mac", hash: "film", name: "Интерстеллар", savePath: "/Volumes/vault/Cinema", os: "darwin", state: "seeding", rawState: "uploading", progress: 1, dlspeed: 0 }),
        torrent({ hostId: "demo-pc", hash: "blend", name: "Blender", savePath: "D:\\Downloads", os: "win32", state: "seeding", rawState: "uploading", progress: 1, dlspeed: 0 }),
      ],
      [vault, games],
      emptyPrefs(),
    );
    const vaultPlan = plans.find((plan) => plan.diskId === "vault");
    const gamesPlan = plans.find((plan) => plan.diskId === "games");
    expect(vaultPlan?.active?.hash).toBe("gow");
    expect(vaultPlan?.queued.map((item) => item.hash)).toEqual(["ubuntu"]);
    expect(vaultPlan?.actions.find((action) => action.hash === "ubuntu")?.action).toBe("pause");
    expect(vaultPlan?.seeding).toHaveLength(1);
    expect(vaultPlan?.actions.find((action) => action.hash === "film")?.action).toBe("keep");
    expect(gamesPlan?.active?.hash).toBe("control");
    expect(gamesPlan?.seeding).toHaveLength(1);
    expect(countActive(plans)).toBe(2);
    for (const plan of plans) {
      expect(plan.actions.filter((action) => action.action === "resume").length).toBeLessThanOrEqual(1);
    }
  });

  it("shares one slot when two hosts mount the same disk", () => {
    const shared: SlotDisk = {
      id: "vault",
      label: "Vault",
      filesystem: "exfat",
      online: true,
      mounts: [
        { hostId: "demo-mac", mountPoint: "/Volumes/vault" },
        { hostId: "demo-pc", mountPoint: "E:\\" },
      ],
      lastMount: null,
    };
    const plans = planScheduler(
      [
        torrent({ hostId: "demo-mac", hash: "a", savePath: "/Volumes/vault/Cinema", os: "darwin" }),
        torrent({ hostId: "demo-pc", hash: "b", savePath: "E:\\Cinema", os: "win32" }),
      ],
      [shared],
      emptyPrefs(),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.active).toBeTruthy();
    expect(plans[0]?.queued).toHaveLength(1);
    expect(plans[0]?.actions.filter((action) => action.action === "pause")).toHaveLength(1);
  });

  it("waits when the disk is offline", () => {
    const shelf: SlotDisk = { ...games, id: "archive", label: "Семейный архив", online: false, mounts: [], lastMount: { hostId: "demo-pc", mountPoint: "E:\\" } };
    const plans = planScheduler(
      [torrent({ hostId: "demo-pc", hash: "wait", savePath: "E:\\Archive", os: "win32" })],
      [shelf],
      emptyPrefs(),
    );
    expect(plans[0]?.online).toBe(false);
    expect(plans[0]?.active).toBeNull();
    expect(plans[0]?.actions[0]?.action).toBe("pause");
    expect(plans[0]?.note).toMatch(/не подключён/);
  });

  it("uses an override without starting a second download", () => {
    const prefs = emptyPrefs();
    prefs.overrideNext["disk:vault"] = "demo-mac:ubuntu";
    const plans = planScheduler(
      [
        torrent({ hostId: "demo-mac", hash: "gow", savePath: "/Volumes/vault/A", os: "darwin", dlspeed: 9 }),
        torrent({ hostId: "demo-mac", hash: "ubuntu", savePath: "/Volumes/vault/B", os: "darwin", dlspeed: 1 }),
      ],
      [vault],
      prefs,
    );
    expect(plans[0]?.active?.hash).toBe("ubuntu");
    expect(plans[0]?.actions.filter((action) => action.action === "pause").map((action) => action.hash)).toEqual(["gow"]);
    expect(plans[0]?.actions.filter((action) => action.action === "resume")).toHaveLength(0);
  });

  it("reorders which torrent is next", () => {
    const prefs = emptyPrefs();
    prefs.order["disk:vault"] = ["demo-mac:second", "demo-mac:first"];
    const plans = planScheduler(
      [
        torrent({ hostId: "demo-mac", hash: "first", savePath: "/Volumes/vault/A", os: "darwin", rawState: "queuedDL", state: "queued", dlspeed: 0 }),
        torrent({ hostId: "demo-mac", hash: "second", savePath: "/Volumes/vault/B", os: "darwin", rawState: "queuedDL", state: "queued", dlspeed: 0 }),
      ],
      [vault],
      prefs,
    );
    expect(plans[0]?.active?.hash).toBe("second");
    expect(plans[0]?.actions.find((action) => action.hash === "second")?.action).toBe("resume");
    expect(plans[0]?.actions.filter((action) => action.action === "resume")).toHaveLength(1);
  });

  it("falls back to host and volume root and says so", () => {
    const slot = resolveSlot([], "demo-pc", "win32", "Z:\\Incoming\\file");
    expect(slot.mode).toBe("fallback");
    expect(slot.key).toBe("fallback:demo-pc:Z:\\");
    expect(slot.note).toMatch(/корень тома/);
    const plans = planScheduler(
      [
        torrent({ hostId: "demo-pc", hash: "one", savePath: "Z:\\Incoming", os: "win32" }),
        torrent({ hostId: "demo-pc", hash: "two", savePath: "Z:\\Other", os: "win32" }),
      ],
      [],
      emptyPrefs(),
    );
    expect(plans).toHaveLength(1);
    expect(countActive(plans)).toBe(1);
  });

  it("does not treat a sibling volume name as the same mount", () => {
    const slot = resolveSlot([vault], "demo-mac", "darwin", "/Volumes/vault-extra/file");
    expect(slot.mode).toBe("fallback");
  });
});
