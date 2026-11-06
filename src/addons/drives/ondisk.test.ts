import { describe, expect, it } from "vitest";

import { compactExplanation, planVolumeCompact, systemCompactReason } from "@/addons/drives/compact-target";
import { resolveOnDisk, rollupOnDisk, savingsOf } from "@/addons/drives/ondisk";

describe("on-disk size", () => {
  it("uses the WOF stream and ignores the unnamed stream length", () => {
    expect(resolveOnDisk({
      size: 10_000,
      allocated: 10_000,
      wofBytes: 2_000,
      wofUnmeasured: false,
      ntfsCompressed: false,
    })).toEqual({ onDisk: 2_000, compression: "wof" });
  });

  it("does not turn a missing or zero WOF length into a full saving", () => {
    expect(resolveOnDisk({
      size: 10_000,
      allocated: 10_000,
      wofBytes: null,
      wofUnmeasured: true,
      ntfsCompressed: false,
    })).toEqual({ onDisk: null, compression: "wof" });
    expect(resolveOnDisk({
      size: 10_000,
      allocated: 8_192,
      wofBytes: 0,
      wofUnmeasured: false,
      ntfsCompressed: false,
    }).onDisk).toBeNull();
    expect(savingsOf(10_000, null)).toBeNull();
  });

  it("keeps an unknown child out of the folder total", () => {
    expect(rollupOnDisk([
      { size: 1000, onDisk: 400, compression: "wof" },
      { size: 1000, onDisk: null, compression: null },
    ]).onDisk).toBeNull();
    expect(rollupOnDisk([
      { size: 1000, onDisk: 400, compression: "wof" },
      { size: 1000, onDisk: 1000, compression: null },
    ])).toMatchObject({ onDisk: 1400, compression: "wof" });
  });
});

describe("compact target", () => {
  const windows = {
    confirm: true,
    algorithm: "XPRESS16K",
    os: "win32" as const,
    filesystem: "NTFS",
    online: true,
    mount: "D:\\",
    relativePath: "Games/Control",
    mode: "agents" as const,
    agentUrl: "http://192.168.0.16:4372",
  };

  it("builds one compact.exe argv and refuses system folders, Mac, and port 4730", () => {
    const plan = planVolumeCompact(windows);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.argv).toEqual([
        "C:\\Windows\\System32\\compact.exe",
        "/C",
        "/EXE:XPRESS16K",
        "/S:D:\\Games\\Control",
      ]);
    }
    expect(planVolumeCompact({ ...windows, confirm: false }).ok).toBe(false);
    expect(planVolumeCompact({ ...windows, os: "darwin", filesystem: "APFS", mount: "/Volumes/vault" }).ok).toBe(false);
    expect(planVolumeCompact({ ...windows, relativePath: "Windows/System32" }).ok).toBe(false);
    expect(planVolumeCompact({ ...windows, relativePath: "Games/WindowsNoEditor" }).ok).toBe(true);
    expect(planVolumeCompact({ ...windows, agentUrl: "http://127.0.0.1:4730" }).ok).toBe(false);
    expect(planVolumeCompact({ ...windows, mode: "mock" }).ok).toBe(false);
    expect(planVolumeCompact({ ...windows, relativePath: "../Windows" }).ok).toBe(false);
    expect(systemCompactReason("C:\\Windows\\System32")).toMatch(/Системный/);
    expect(systemCompactReason("D:\\Games\\WindowsNoEditor")).toBeNull();
    expect(compactExplanation({
      kind: "dir",
      online: true,
      os: "darwin",
      filesystem: "APFS",
      displayPath: "/Volumes/vault/Games",
    })).toMatch(/Mac/);
  });
});
