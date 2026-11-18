import { describe, expect, it } from "vitest";

import { applyRawDelta, indexMode } from "@/addons/drives/index-mode";

describe("index mode", () => {
  it("reads NTFS from MFT once, then only the USN cursor", () => {
    expect(indexMode({
      filesystem: "NTFS",
      platform: "win32",
      hasCatalog: false,
      usnCursor: null,
      lastEventId: null,
      journalLost: false,
      reason: "attach",
    })).toBe("mft");
    expect(indexMode({
      filesystem: "NTFS",
      platform: "win32",
      hasCatalog: true,
      usnCursor: "40",
      lastEventId: null,
      journalLost: false,
      reason: "change",
    })).toBe("usn");
    expect(indexMode({
      filesystem: "NTFS",
      platform: "win32",
      hasCatalog: true,
      usnCursor: "40",
      lastEventId: null,
      journalLost: false,
      reason: "restart",
    })).toBe("usn");
    expect(indexMode({
      filesystem: "NTFS",
      platform: "win32",
      hasCatalog: true,
      usnCursor: "40",
      lastEventId: null,
      journalLost: true,
      reason: "change",
    })).toBe("mft");
    expect(indexMode({
      filesystem: "NTFS",
      platform: "win32",
      hasCatalog: true,
      usnCursor: null,
      lastEventId: null,
      journalLost: false,
      reason: "restart",
    })).toBe("none");
  });

  it("walks APFS only on first attach or a dropped FSEvents history", () => {
    expect(indexMode({
      filesystem: "APFS",
      platform: "darwin",
      hasCatalog: false,
      usnCursor: null,
      lastEventId: null,
      journalLost: false,
      reason: "attach",
    })).toBe("walk");
    expect(indexMode({
      filesystem: "HFS+",
      platform: "darwin",
      hasCatalog: true,
      usnCursor: null,
      lastEventId: "900",
      journalLost: false,
      reason: "restart",
    })).toBe("fsevents");
    expect(indexMode({
      filesystem: "APFS",
      platform: "darwin",
      hasCatalog: true,
      usnCursor: null,
      lastEventId: "900",
      journalLost: true,
      reason: "restart",
    })).toBe("walk");
    expect(indexMode({
      filesystem: "APFS",
      platform: "darwin",
      hasCatalog: true,
      usnCursor: null,
      lastEventId: null,
      journalLost: false,
      reason: "change",
    })).toBe("fsevents");
  });

  it("walks exFAT once on attach and ignores later change events", () => {
    expect(indexMode({
      filesystem: "exFAT",
      platform: "darwin",
      hasCatalog: false,
      usnCursor: null,
      lastEventId: null,
      journalLost: false,
      reason: "attach",
    })).toBe("walk");
    expect(indexMode({
      filesystem: "FAT32",
      platform: "win32",
      hasCatalog: true,
      usnCursor: null,
      lastEventId: null,
      journalLost: false,
      reason: "change",
    })).toBe("none");
    expect(indexMode({
      filesystem: "exFAT",
      platform: "win32",
      hasCatalog: true,
      usnCursor: null,
      lastEventId: null,
      journalLost: false,
      reason: "restart",
    })).toBe("none");
  });

  it("applies a journal delta without copying the whole tree from scratch", () => {
    const next = applyRawDelta(
      [
        { relativePath: "keep.txt", name: "keep.txt", kind: "file", size: 1, mtimeMs: 0 },
        { relativePath: "gone.txt", name: "gone.txt", kind: "file", size: 2, mtimeMs: 0 },
      ],
      {
        upserts: [{ relativePath: "keep.txt", name: "keep.txt", kind: "file", size: 5, mtimeMs: 3 }],
        deletes: ["gone.txt"],
        complete: true,
      },
    );
    expect(next).toEqual([{ relativePath: "keep.txt", name: "keep.txt", kind: "file", size: 5, mtimeMs: 3 }]);
  });
});
