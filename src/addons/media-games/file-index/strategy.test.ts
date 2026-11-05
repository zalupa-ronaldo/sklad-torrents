import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeMftFixture } from "@/addons/media-games/file-index/mft";
import { MemoryFileIndex } from "@/addons/media-games/file-index/memory";
import { sourceBadgeLabel } from "@/addons/media-games/file-index/labels";
import {
  chooseIndexStrategy,
  explainStrategy,
  isRawNtfsAllowed,
} from "@/addons/media-games/file-index/strategy";
import { encodeUsnRecord, UsnReason } from "@/addons/media-games/file-index/usn";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-index-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "Games"));
  await writeFile(path.join(dir, "Games", "local.txt"), "walk");
  return dir;
}

describe("index strategy", () => {
  it("always walks Mac, APFS, and /Volumes/vault", () => {
    expect(chooseIndexStrategy({ os: "darwin", volume: "/Volumes/vault", filesystem: "apfs", elevated: true })).toBe(
      "walk",
    );
    expect(
      chooseIndexStrategy({ os: "darwin", volume: "D:", filesystem: "ntfs", elevated: true, preferUsn: true }),
    ).toBe("walk");
    expect(
      chooseIndexStrategy({
        os: "win32",
        volume: "/Volumes/vault",
        filesystem: "ntfs",
        elevated: true,
        preferUsn: true,
      }),
    ).toBe("walk");
    expect(
      chooseIndexStrategy({ os: "linux", volume: "/Volumes/vault/Games", filesystem: "ntfs", elevated: true }),
    ).toBe("walk");
    expect(chooseIndexStrategy({ os: "win32", volume: "E:", filesystem: "apfs", elevated: true })).toBe("walk");
    expect(isRawNtfsAllowed("/Volumes/vault")).toBe(false);
    expect(isRawNtfsAllowed("/Volumes/vault/Games")).toBe(false);
  });

  it("walks a Windows NTFS volume when the process is not elevated", () => {
    expect(chooseIndexStrategy({ os: "win32", volume: "D:", filesystem: "ntfs", elevated: false })).toBe("walk");
    expect(chooseIndexStrategy({ os: "win32", volume: "D:\\", filesystem: "ntfs", elevated: false, preferUsn: true })).toBe(
      "walk",
    );
    expect(explainStrategy({ os: "win32", volume: "D:", filesystem: "ntfs", elevated: false }, "walk")).toMatch(
      /MFT недоступен/,
    );
    expect(explainStrategy({ os: "win32", volume: "D:", filesystem: "ntfs", elevated: false }, "walk")).toMatch(
      /обходом папок/,
    );
  });

  it("selects MFT for a full elevated NTFS build and USN for the journal", () => {
    expect(chooseIndexStrategy({ os: "win32", volume: "D:", filesystem: "ntfs", elevated: true })).toBe("mft");
    expect(chooseIndexStrategy({ os: "win32", volume: "\\\\.\\E:", filesystem: "ntfs", elevated: true })).toBe("mft");
    expect(
      chooseIndexStrategy({ os: "win32", volume: "D:", filesystem: "ntfs", elevated: true, preferUsn: true }),
    ).toBe("usn");
    expect(isRawNtfsAllowed("D:")).toBe(true);
    expect(isRawNtfsAllowed("\\\\.\\E:")).toBe(true);
    expect(sourceBadgeLabel("mft")).toBe("MFT");
    expect(sourceBadgeLabel("usn")).toBe("USN");
    expect(sourceBadgeLabel("walk")).toBe("обход папок");
  });

  it("does not run MFT or USN readers against /Volumes/vault", async () => {
    const walkRoot = await scratch();
    const readNtfs = vi.fn(async () => encodeUsnRecord({
      fileRef: 9n,
      parentRef: 5n,
      reason: UsnReason.FILE_CREATE,
      name: "ShouldNotAppear",
    }));
    const index = new MemoryFileIndex();
    const status = await index.indexVolume({
      host: "Mac mini",
      volume: "/Volumes/vault",
      os: "darwin",
      filesystem: "apfs",
      elevated: true,
      preferUsn: true,
      walkRoot,
      mftFixture: encodeMftFixture([
        { recordNumber: 5, parentRecord: 5, isDirectory: true, name: "." },
        { recordNumber: 9, parentRecord: 5, name: "FromMftFixture" },
      ]),
      usnJournal: encodeUsnRecord({
        fileRef: 9n,
        parentRef: 5n,
        reason: UsnReason.FILE_CREATE,
        name: "FromUsnJournal",
      }),
      readNtfs,
    });
    expect(status.source).toBe("walk");
    expect(status.volume).toBe("/Volumes/vault");
    expect(readNtfs).not.toHaveBeenCalled();
    expect(index.search("local.txt")[0]).toMatchObject({
      host: "Mac mini",
      path: "/Volumes/vault/Games/local.txt",
      source: "walk",
    });
    expect(index.search("FromMftFixture")).toEqual([]);
    expect(index.search("FromUsnJournal")).toEqual([]);
    expect(index.search("ShouldNotAppear")).toEqual([]);
    expect(sourceBadgeLabel(status.source)).toBe("обход папок");
  });

  it("ignores an MFT fixture on a non-elevated Windows volume and walks instead", async () => {
    const walkRoot = await scratch();
    const readNtfs = vi.fn();
    const index = new MemoryFileIndex();
    const status = await index.indexVolume({
      host: "Windows PC",
      volume: "D:",
      os: "win32",
      filesystem: "ntfs",
      elevated: false,
      walkRoot,
      mftFixture: encodeMftFixture([
        { recordNumber: 5, parentRecord: 5, isDirectory: true, name: "." },
        { recordNumber: 8, parentRecord: 5, name: "OnlyInFixture" },
      ]),
      readNtfs,
    });
    expect(status.source).toBe("walk");
    expect(status.elevated).toBe(false);
    expect(status.message).toMatch(/MFT недоступен/);
    expect(readNtfs).not.toHaveBeenCalled();
    expect(index.search("OnlyInFixture")).toEqual([]);
    expect(index.search("local.txt")[0]).toMatchObject({
      host: "Windows PC",
      path: "D:\\Games\\local.txt",
      source: "walk",
    });
  });

  it("reads NTFS through the supplied reader only when elevated", async () => {
    const fixture = encodeMftFixture([
      { recordNumber: 5, parentRecord: 5, isDirectory: true, name: "." },
      { recordNumber: 4, parentRecord: 5, isDirectory: true, name: "Games" },
      { recordNumber: 6, parentRecord: 4, size: 12, name: "Control.exe" },
    ]);
    const readNtfs = vi.fn(async (source: "mft" | "usn") => {
      expect(source).toBe("mft");
      return fixture;
    });
    const index = new MemoryFileIndex();
    const status = await index.indexVolume({
      host: "Windows PC",
      volume: "\\\\.\\D:",
      os: "win32",
      filesystem: "ntfs",
      elevated: true,
      readNtfs,
    });
    expect(readNtfs).toHaveBeenCalledOnce();
    expect(status).toMatchObject({ source: "mft", volume: "D:", elevated: true, host: "Windows PC" });
    expect(index.search("Control")[0]).toMatchObject({
      host: "Windows PC",
      path: "D:\\Games\\Control.exe",
      source: "mft",
    });
  });
});
