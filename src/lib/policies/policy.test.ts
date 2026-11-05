import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CatalogDisk } from "@/lib/drives/types";
import { DEMO_HASH, DEMO_MAC_ID, DEMO_PC_ID } from "@/lib/qbittorrent/demo-data";
import { resetMockStateForTests } from "@/lib/qbittorrent/mock-client";
import { getTorrentDetail } from "@/lib/qbittorrent/service";
import { buildDryRun, enableAutomation, replaceRules } from "@/lib/policies/dry-run";
import { emptyRules } from "@/lib/policies/presets";
import { applyNamedPreset, defaultPolicy } from "@/lib/policies/store";
import { applyPolicyPass, runPreview, setAutomationEnabled } from "@/lib/policies/service";
import { catalogDiskKey } from "@/lib/scheduler/disk-key";
import { planDownloads } from "@/lib/scheduler/plan";
import type { DryRunInput, PolicyTorrent, TypeRule } from "@/lib/policies/types";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

const MEDIA = disk({
  serial: "SN-MEDIA",
  uuid: "UUID-MEDIA",
  label: "Медиадиск",
  online: true,
  hostId: DEMO_PC_ID,
  os: "win32",
  path: "E:\\",
});
const GAMES = disk({
  serial: "SN-GAMES",
  uuid: "UUID-GAMES",
  label: "Игры HDD",
  online: true,
  hostId: DEMO_PC_ID,
  os: "win32",
  path: "D:\\",
});
const VAULT = disk({
  serial: "SN-VAULT",
  uuid: "UUID-VAULT",
  label: "Vault",
  online: true,
  hostId: DEMO_MAC_ID,
  os: "darwin",
  path: "/Volumes/vault",
});
const OFFLINE = disk({
  serial: "SN-OFF",
  uuid: "UUID-OFF",
  label: "Полка",
  online: false,
  hostId: DEMO_PC_ID,
  os: "win32",
  path: "G:\\",
});

function disk(input: {
  serial: string;
  uuid: string;
  label: string;
  online: boolean;
  hostId: string;
  os: "darwin" | "win32";
  path: string;
}): CatalogDisk {
  return {
    serial: input.serial,
    uuid: input.uuid,
    label: input.label,
    online: input.online,
    mounts: [{ hostId: input.hostId, os: input.os, path: input.path }],
  };
}

function torrent(partial: Partial<PolicyTorrent> & Pick<PolicyTorrent, "hash" | "name">): PolicyTorrent {
  return {
    hostId: DEMO_PC_ID,
    hostName: "Windows PC",
    savePath: "D:\\Downloads",
    progress: 1,
    state: "seeding",
    addedOn: 1,
    files: [],
    ...partial,
  };
}

function input(partial: Partial<DryRunInput> = {}): DryRunInput {
  return {
    torrents: [],
    hosts: [
      { id: DEMO_MAC_ID, name: "Mac mini", os: "darwin", online: true },
      { id: DEMO_PC_ID, name: "Windows PC", os: "win32", online: true },
    ],
    disks: [MEDIA, GAMES, VAULT, OFFLINE],
    rules: emptyRules(),
    overrides: [],
    ...partial,
  };
}

describe("content policies", () => {
  it("plans disk, folder, index profile and post-process without a delete step", () => {
    const rules = emptyRules();
    rules.movie = { ...rules.movie, diskId: catalogDiskKey(MEDIA.serial, MEDIA.uuid), folder: "Cinema", indexProfile: "walk", postAction: "handbrake" };
    const result = buildDryRun(
      input({
        rules,
        torrents: [
          torrent({
            hash: HASH_A,
            name: "Интерстеллар (2014) 2160p",
            savePath: "D:\\Downloads",
            files: [{ name: "Interstellar.mkv", size: 62_400_000_000 }],
          }),
        ],
      }),
    );
    expect(result.deletesSource).toBe(false);
    const row = result.rows[0];
    expect(row).toMatchObject({
      kind: "movie",
      diskLabel: "Медиадиск",
      folder: "Cinema",
      indexProfile: "walk",
      postAction: "handbrake",
      deletesSource: false,
      destinationPath: "E:\\Cinema",
    });
    expect(row.steps.map((step) => step.type)).toContain("setLocation");
    expect(row.steps.map((step) => step.type)).not.toContain("delete");
    expect(JSON.stringify(result)).not.toContain('"type":"delete"');
    expect(JSON.stringify(result)).not.toContain('"deleteFiles":true');
    expect(row.steps.find((step) => step.type === "setLocation")).toEqual({
      type: "setLocation",
      via: "qbittorrent.setLocation",
      location: "E:\\Cinema",
      deletesFiles: false,
    });
  });

  it("rejects automation without a fresh dry-run and after rules change", () => {
    const policy = defaultPolicy();
    expect(() => enableAutomation(policy, "abc", "abc")).toThrow(/прогон/);
    const previewed = { ...policy, preview: { fingerprint: "abc", at: 1 } };
    expect(() => enableAutomation(previewed, "abc", "stale")).toThrow(/прогон/);
    const enabled = enableAutomation(previewed, "abc", "abc");
    expect(enabled.automationEnabled).toBe(true);
    const changed = replaceRules(enabled, { ...enabled.rules, music: { ...enabled.rules.music, folder: "Audio" } }, "custom");
    expect(changed.preview).toBeNull();
    expect(changed.automationEnabled).toBe(false);
    expect(() => enableAutomation(changed, "abc", "abc")).toThrow(/прогон/);
  });

  it("does not let a preset turn automation on", () => {
    const policy = defaultPolicy();
    expect(applyNamedPreset(policy, "index-only").automationEnabled).toBe(false);
    expect(applyNamedPreset(policy, "shelf").automationEnabled).toBe(false);
    expect(applyNamedPreset(policy, "handbrake-cinema").presetId).toBe("handbrake-cinema");
  });

  it("drops NTFS compact on an APFS destination and keeps it on NTFS", () => {
    const apfsRules = emptyRules();
    apfsRules.game = gameRule(catalogDiskKey(VAULT.serial, VAULT.uuid), "compact", "ntfs-mft");
    const apfs = buildDryRun(
      input({
        rules: apfsRules,
        torrents: [
          torrent({
            hostId: DEMO_MAC_ID,
            hostName: "Mac mini",
            hash: HASH_A,
            name: "God of War (PSP)",
            savePath: "/Volumes/vault/Downloads",
            files: [{ name: "ULUS10479.iso", size: 1_800_000_000 }],
          }),
        ],
      }),
    );
    const mac = apfs.rows[0];
    expect(mac).toMatchObject({
      kind: "game",
      gameSubtype: "psp",
      filesystem: "apfs",
      postAction: "none",
      postActionRequested: "compact",
      postUnavailable: true,
      indexProfile: "walk",
      indexRequested: "ntfs-mft",
    });
    expect(mac.postNote).toMatch(/APFS/);
    expect(mac.indexNote).toMatch(/APFS/);
    expect(mac.steps.some((step) => step.type === "queue-compact")).toBe(false);

    const ntfsRules = emptyRules();
    ntfsRules.game = gameRule(catalogDiskKey(GAMES.serial, GAMES.uuid), "compact", "ntfs-mft");
    const ntfs = buildDryRun(
      input({
        rules: ntfsRules,
        torrents: [
          torrent({
            hash: HASH_B,
            name: "God of War (PSP)",
            savePath: "D:\\Downloads",
            files: [{ name: "ULUS10479.iso", size: 1_800_000_000 }],
          }),
        ],
      }),
    );
    expect(ntfs.rows[0].postAction).toBe("compact");
    expect(ntfs.rows[0].steps.some((step) => step.type === "queue-compact")).toBe(true);
    expect(ntfs.rows[0].steps.find((step) => step.type === "setLocation")).toMatchObject({
      via: "qbittorrent.setLocation",
      deletesFiles: false,
    });
  });

  it("keeps one active download when two torrents share a disk", () => {
    const rules = emptyRules();
    rules.game = gameRule(catalogDiskKey(GAMES.serial, GAMES.uuid), "none", "walk");
    const shared = [
      torrent({
        hash: HASH_A,
        name: "Control",
        savePath: "D:\\Games\\Control",
        progress: 0.4,
        state: "downloading",
        addedOn: 10,
        files: [{ name: "Control/Control.exe", size: 80_000_000 }],
      }),
      torrent({
        hash: HASH_B,
        name: "Deus Ex",
        savePath: "D:\\Games\\Deus Ex",
        progress: 0.2,
        state: "downloading",
        addedOn: 20,
        files: [{ name: "Deus Ex/dx.exe", size: 40_000_000 }],
      }),
    ];
    const result = buildDryRun(input({ rules, torrents: shared }));
    expect(result.rows.every((row) => row.kind === "game" && row.diskId === catalogDiskKey(GAMES.serial, GAMES.uuid))).toBe(true);
    expect(result.rows.filter((row) => row.scheduler === "active")).toHaveLength(1);
    expect(result.rows.filter((row) => row.scheduler === "queued")).toHaveLength(1);

    const offlineRules = emptyRules();
    offlineRules.game = gameRule(catalogDiskKey(OFFLINE.serial, OFFLINE.uuid), "none", "walk");
    const offline = buildDryRun(input({ rules: offlineRules, torrents: shared }));
    expect(offline.rows.filter((row) => row.scheduler === "active")).toHaveLength(0);
    expect(offline.rows.every((row) => row.scheduler === "waiting-offline")).toBe(true);
    expect(offline.rows.every((row) => row.steps.every((step) => step.type !== "setLocation"))).toBe(true);
  });

  it("asks the disk scheduler for a single active download", () => {
    const catalog = [GAMES];
    const plan = planDownloads({
      torrents: [
        {
          hostId: DEMO_PC_ID,
          hostName: "Windows PC",
          hostOs: "win32",
          hash: HASH_A,
          name: "Control",
          savePath: "D:\\Games\\Control",
          state: "downloading",
          rawState: "downloading",
          progress: 0.4,
          userPaused: false,
        },
        {
          hostId: DEMO_PC_ID,
          hostName: "Windows PC",
          hostOs: "win32",
          hash: HASH_B,
          name: "Deus Ex",
          savePath: "D:\\Games\\Deus Ex",
          state: "downloading",
          rawState: "downloading",
          progress: 0.2,
          userPaused: false,
        },
      ],
      catalog,
      order: {},
      priority: {},
    });
    expect(plan.queues).toHaveLength(1);
    expect(plan.queues[0]?.active).toBeTruthy();
    expect(plan.queues[0]?.waiting).toHaveLength(1);
    const offline = planDownloads({
      torrents: [
        {
          hostId: DEMO_PC_ID,
          hostName: "Windows PC",
          hostOs: "win32",
          hash: HASH_A,
          name: "Control",
          savePath: "G:\\Games\\Control",
          state: "downloading",
          rawState: "downloading",
          progress: 0.4,
          userPaused: false,
        },
      ],
      catalog: [OFFLINE],
      order: {},
      priority: {},
    });
    expect(offline.queues[0]?.active).toBeNull();
    expect(offline.queues[0]?.online).toBe(false);
  });
});

describe("policy service", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sklad-policy-"));
    process.env.SKLAD_DATA_DIR = dir;
    resetMockStateForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.SKLAD_DATA_DIR;
  });

  it("requires a stored preview before enable, then moves finished torrents with setLocation", async () => {
    await expect(setAutomationEnabled(true, "")).rejects.toThrow(/прогон/);
    const preview = await runPreview();
    expect(preview.rows.length).toBeGreaterThan(0);
    expect(preview.deletesSource).toBe(false);
    expect(preview.rows.every((row) => row.deletesSource === false)).toBe(true);
    expect(JSON.stringify(preview.rows.flatMap((row) => row.steps))).not.toContain('"type":"delete"');

    const gow = preview.rows.find((row) => row.hash === DEMO_HASH.godOfWar);
    expect(gow).toMatchObject({ kind: "game", gameSubtype: "psp", reason: "extension" });
    const games = preview.rows.filter((row) => row.kind === "game" && row.scheduler !== "idle");
    expect(games.filter((row) => row.scheduler === "active")).toHaveLength(1);

    const blenderPlan = preview.rows.find((row) => row.hash === DEMO_HASH.blender);
    expect(blenderPlan?.steps.find((step) => step.type === "setLocation")).toMatchObject({
      via: "qbittorrent.setLocation",
      deletesFiles: false,
    });

    await expect(setAutomationEnabled(true, "not-the-preview")).rejects.toThrow(/прогон/);
    const enabled = await setAutomationEnabled(true, preview.fingerprint);
    expect(enabled.automationEnabled).toBe(true);

    const applied = await applyPolicyPass(preview.fingerprint);
    expect(applied.deletesSource).toBe(false);
    expect(applied.moves.length).toBeGreaterThan(0);
    expect(applied.moves.every((move) => move.via === "qbittorrent.setLocation")).toBe(true);
    const detail = await getTorrentDetail(DEMO_PC_ID, DEMO_HASH.blender);
    expect(detail.torrent.savePath).toBe("D:\\Software");
    expect(detail.files.length).toBeGreaterThan(0);
    expect(applied.jobs.some((job) => job.kind === "handbrake" && job.deleteSource === false && job.torrentName.length > 0)).toBe(true);
    expect(applied.jobs.filter((job) => job.kind === "handbrake").every((job) => job.outputPath.length > 0)).toBe(true);
  });
});

function gameRule(diskId: string, postAction: TypeRule["postAction"], indexProfile: TypeRule["indexProfile"]): TypeRule {
  return {
    ...emptyRules().game,
    diskId,
    folder: "Games",
    postAction,
    indexProfile,
  };
}
