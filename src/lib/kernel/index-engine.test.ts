import { describe, expect, it } from "vitest";

import { applyIndexResult, planIndex } from "@/lib/kernel/index-engine";
import type { CatalogFile } from "@/lib/kernel/types";

const previous: CatalogFile[] = [
  { path: "keep.txt", size: 10 },
  { path: "photo.jpg", size: 20 },
];

describe("read-only index", () => {
  it("does not mark files deleted when the walk fails", () => {
    const outcome = planIndex({
      filesystem: "ntfs",
      mountPoint: "E:\\",
      elevated: false,
      previous: { files: previous, complete: true },
      heavyActivity: false,
      walk: () => {
        throw new Error("том отвалился");
      },
    });
    expect(outcome.committed).toBe(false);
    expect(outcome.files).toBeNull();
    expect(applyIndexResult(previous, outcome)).toEqual(previous);
  });

  it("does not mark files deleted when USN fails", () => {
    const outcome = planIndex({
      filesystem: "ntfs",
      mountPoint: "E:\\",
      elevated: true,
      previous: { files: previous, complete: true },
      heavyActivity: false,
      readUsn: () => {
        throw new Error("журнал оборвался");
      },
    });
    expect(outcome.method).toBeNull();
    expect(applyIndexResult(previous, outcome)).toEqual(previous);
  });

  it("pauses on heavy activity and keeps the previous list", () => {
    const outcome = planIndex({
      filesystem: "ntfs",
      mountPoint: "D:\\",
      elevated: true,
      previous: { files: previous, complete: true },
      heavyActivity: true,
      readMft: () => [],
    });
    expect(outcome.paused).toBe(true);
    expect(applyIndexResult(previous, outcome)).toEqual(previous);
  });

  it("uses a walk for APFS even if an MFT reader is passed", () => {
    const outcome = planIndex({
      filesystem: "apfs",
      mountPoint: "/",
      elevated: true,
      previous: null,
      heavyActivity: false,
      readMft: () => {
        throw new Error("MFT вызван на APFS");
      },
      walk: () => [{ path: "Users/a.txt", size: 1 }],
    });
    expect(outcome.method).toBe("walk");
    expect(outcome.files).toEqual([{ path: "Users/a.txt", size: 1 }]);
  });

  it("never runs MFT against /Volumes/vault", () => {
    const outcome = planIndex({
      filesystem: "ntfs",
      mountPoint: "/Volumes/vault",
      elevated: true,
      previous: { files: previous, complete: true },
      heavyActivity: false,
      readMft: () => {
        throw new Error("MFT на vault");
      },
      readUsn: () => {
        throw new Error("USN на vault");
      },
      walk: () => previous,
    });
    expect(outcome.method).toBe("walk");
    expect(outcome.message).toMatch(/vault/i);
  });

  it("reads MFT on elevated NTFS and USN when the previous scan completed", () => {
    const full = planIndex({
      filesystem: "ntfs",
      mountPoint: "D:\\",
      elevated: true,
      previous: null,
      heavyActivity: false,
      readMft: () => previous,
    });
    expect(full.method).toBe("mft");
    const delta = planIndex({
      filesystem: "ntfs",
      mountPoint: "D:\\",
      elevated: true,
      previous: { files: previous, complete: true },
      heavyActivity: false,
      readUsn: (files) => [...files, { path: "new.txt", size: 3 }],
      readMft: () => [],
    });
    expect(delta.method).toBe("usn");
    expect(delta.files).toHaveLength(3);
  });

  it("falls back to a walk when NTFS is not elevated", () => {
    const outcome = planIndex({
      filesystem: "ntfs",
      mountPoint: "D:\\",
      elevated: false,
      previous: { files: previous, complete: true },
      heavyActivity: false,
      readMft: () => [],
      walk: () => previous,
    });
    expect(outcome.method).toBe("walk");
    expect(outcome.message).toMatch(/администратор/);
  });
});
