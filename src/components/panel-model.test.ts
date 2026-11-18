import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOAD_POLICY,
  copyGroup,
  folderFileCountLabel,
  isHiddenPanelVolume,
  isQueueJob,
  jobsToPause,
  panelDiskCaption,
  panelDiskStrip,
  parseLoadPolicy,
  queueTotals,
  relocateBlocked,
  torrentMatches,
  withinSchedule,
} from "@/components/panel-model";

const TB = 1024 ** 4;
const GB = 1024 ** 3;

describe("panel disk caption", () => {
  it("names a volume by capacity and label, then free space, type and letter", () => {
    const face = {
      label: "vault",
      volumeName: "vault",
      lastMountPath: "D:\\",
      mountPaths: ["D:\\"],
      totalBytes: TB,
      freeBytes: 400 * GB,
      filesystem: "NTFS",
    };
    expect(panelDiskStrip(face).title).toBe("1 ТБ · vault");
    expect(panelDiskStrip(face).rest).toBe("свободно 400 ГБ · NTFS · D:");
    expect(panelDiskCaption(face)).toBe("1 ТБ · vault · свободно 400 ГБ · NTFS · D:");
    expect(
      panelDiskStrip({
        ...face,
        strip: { title: "1 ТБ · vault", detail: "1 ТБ · vault · свободно 372,5 ГБ · NTFS · D:" },
      }).title,
    ).toBe("1 ТБ · vault");
  });

  it("hides Z: and does not repeat a letter that is already the label", () => {
    expect(isHiddenPanelVolume({ lastMountPath: "Z:\\", mountPaths: ["Z:\\"], label: "Data" })).toBe(true);
    expect(isHiddenPanelVolume({ lastMountPath: "E:\\", mountPaths: ["E:\\"], label: "archive" })).toBe(true);
    expect(isHiddenPanelVolume({ lastMountPath: "/mnt/z", label: "Data" })).toBe(true);
    expect(isHiddenPanelVolume({ lastMountPath: "Z:\\", snapshotOnly: true, label: "Data" })).toBe(false);
    expect(isHiddenPanelVolume({ lastMountPath: "D:\\", label: "vault" })).toBe(false);
    expect(isHiddenPanelVolume({ lastMountPath: "F:\\", label: "виртуальный диск Alcohol" })).toBe(false);
    expect(
      panelDiskCaption({
        label: "C:",
        volumeName: "C:",
        lastMountPath: "C:\\",
        totalBytes: TB,
        freeBytes: GB,
        filesystem: "NTFS",
      }),
    ).toBe("1 ТБ · C: · свободно 1 ГБ · NTFS");
  });
});

describe("copy groups and folder counts", () => {
  it("sends Mac, flash and disk into separate groups and skips the browser", () => {
    expect(copyGroup({ id: "mac-downloads", kind: "mac-downloads", label: "Mac mini · Загрузки" })).toBe("mac");
    expect(copyGroup({ id: "disk:1", kind: "disk", label: "Флешка · 16 ГБ · NO NAME" })).toBe("flash");
    expect(copyGroup({ id: "disk:2", kind: "disk", label: "1 ТБ · vault" })).toBe("disk");
    expect(copyGroup({ id: "browser", kind: "browser", label: "Браузер" })).toBeNull();
  });

  it("prints a folder file count apart from the byte sum", () => {
    expect(folderFileCountLabel("dir", 1280).replace(/\D/g, "")).toBe("1280");
    expect(folderFileCountLabel("file", 1)).toBe("—");
    expect(folderFileCountLabel("dir", null)).toBe("—");
  });
});

describe("torrent relocate and search", () => {
  it("blocks E: and Z: and keeps a normal destination", () => {
    expect(relocateBlocked("Z:\\Cinema")).toMatch(/Z:/);
    expect(relocateBlocked("E:\\Archive")).toMatch(/E:/);
    expect(relocateBlocked("D:\\Games")).toBeNull();
    expect(relocateBlocked("/Volumes/vault/Cinema")).toBeNull();
  });

  it("matches a torrent by name, path or host", () => {
    const torrent = { name: "Interstellar", savePath: "/Volumes/vault/Cinema", hostName: "Mac mini", contentPath: "" };
    expect(torrentMatches(torrent, "vault")).toBe(true);
    expect(torrentMatches(torrent, "mac")).toBe(true);
    expect(torrentMatches(torrent, "ubuntu")).toBe(false);
  });
});

describe("queue totals and load pauses", () => {
  const jobs = [
    { id: "a", status: "running" as const, progress: 0.8, canPause: true, processedBytes: 80, totalBytes: 100, speed: 10 },
    { id: "b", status: "running" as const, progress: 0.2, canPause: true, processedBytes: 20, totalBytes: 100, speed: 5 },
    { id: "c", status: "running" as const, progress: 0.5, canPause: false, processedBytes: 5, totalBytes: 10, speed: 1 },
    { id: "d", status: "paused" as const, progress: 0.4, canPause: false, processedBytes: 40, totalBytes: 100, speed: 0 },
  ];

  it("sums the live queue", () => {
    const totals = queueTotals(jobs);
    expect(totals.liveCount).toBe(4);
    expect(totals.processedBytes).toBe(145);
    expect(totals.totalBytes).toBe(310);
    expect(totals.speed).toBe(16);
    expect(totals.progress).toBeCloseTo(145 / 310);
  });

  it("keeps downloads in the queue and leaves a finished seed out", () => {
    expect(isQueueJob({ kind: "torrent", status: "running", progress: 0.4 })).toBe(true);
    expect(isQueueJob({ kind: "torrent", status: "running", progress: 1 })).toBe(false);
    expect(isQueueJob({ kind: "copy", status: "paused", progress: 0.2 })).toBe(true);
    expect(isQueueJob({ kind: "transcode", status: "completed", progress: 1 })).toBe(false);
  });

  it("does not pause anything under the default policy", () => {
    expect(jobsToPause(jobs, DEFAULT_LOAD_POLICY, new Date("2026-11-15T12:00:00"))).toEqual([]);
  });

  it("pauses every pausable running task in quiet mode and leaves the rest", () => {
    expect(jobsToPause(jobs, { ...DEFAULT_LOAD_POLICY, quiet: true }, new Date())).toEqual(["a", "b"]);
  });

  it("keeps the furthest tasks when the parallel cap is on", () => {
    expect(jobsToPause(jobs, { ...DEFAULT_LOAD_POLICY, limitParallel: true, parallel: 1 }, new Date())).toEqual(["b"]);
  });

  it("pauses outside the schedule and stays quiet inside it", () => {
    const policy = { ...DEFAULT_LOAD_POLICY, scheduleEnabled: true, scheduleFrom: "01:00", scheduleTo: "08:00" };
    expect(withinSchedule(new Date("2026-11-15T02:30:00"), "01:00", "08:00")).toBe(true);
    expect(withinSchedule(new Date("2026-11-15T12:00:00"), "01:00", "08:00")).toBe(false);
    expect(withinSchedule(new Date("2026-11-15T23:00:00"), "22:00", "06:00")).toBe(true);
    expect(jobsToPause(jobs, policy, new Date("2026-11-15T12:00:00"))).toEqual(["a", "b"]);
    expect(jobsToPause(jobs, policy, new Date("2026-11-15T02:00:00"))).toEqual([]);
  });

  it("reads a saved policy and ignores junk", () => {
    expect(parseLoadPolicy(JSON.stringify({ quiet: true, parallel: 3, limitParallel: true, scheduleFrom: "9:00", scheduleTo: "99:00" }))).toMatchObject({
      quiet: true,
      parallel: 3,
      limitParallel: true,
      scheduleFrom: "9:00",
      scheduleTo: "08:00",
    });
    expect(parseLoadPolicy("nope")).toEqual(DEFAULT_LOAD_POLICY);
  });
});
