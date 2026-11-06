import { describe, expect, it } from "vitest";

import { browseDisk, browseRoots, buildDiskTree } from "@/addons/drives/browse";
import type { DiskRecord, IndexedFile } from "@/addons/drives/types";

function disk(partial: Partial<DiskRecord> & { files: IndexedFile[] }): DiskRecord {
  return {
    id: partial.id || "disk-s",
    serial: "SN",
    serialNorm: "sn",
    volumeUuid: "uuid",
    uuidNorm: "uuid",
    filesystem: "NTFS",
    label: partial.label || "Games",
    namedByUser: false,
    volumeName: "Games",
    totalBytes: 8_000_000_000_000,
    freeBytes: 1_000_000_000_000,
    lastSeenAt: "2026-11-05T00:00:00.000Z",
    lastHostId: "windows-pc",
    lastHostName: "Windows PC",
    pathStyle: "win32",
    lastMountPath: partial.lastMountPath || "S:\\",
    priorMountPath: "",
    connectedHosts: partial.connectedHosts ?? [],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: { status: "complete", strategy: "mft-usn", progress: 1, message: "ok", elevated: true },
    files: partial.files,
    indexRevision: partial.indexRevision || "r1",
  };
}

describe("browse aggregates", () => {
  const files: IndexedFile[] = [
    { relativePath: "games/RimWorld/RimWorldWin64.exe", name: "RimWorldWin64.exe", kind: "file", size: 100, mtimeMs: 10, sidecarCategory: null, categories: ["game"] },
    { relativePath: "games/RimWorld/Data/core", name: "core", kind: "file", size: 50, mtimeMs: 20, sidecarCategory: null, categories: ["game"] },
    { relativePath: "games/Hades/Hades.exe", name: "Hades.exe", kind: "file", size: 200, mtimeMs: 5, sidecarCategory: null, categories: ["game"] },
    { relativePath: "видеки/Interstellar.mkv", name: "Interstellar.mkv", kind: "file", size: 1000, mtimeMs: 30, sidecarCategory: null, categories: ["media"] },
    { relativePath: "Music/track.flac", name: "track.flac", kind: "file", size: 40, mtimeMs: 1, sidecarCategory: null, categories: ["music"] },
  ];

  it("rolls up recursive folder sizes", () => {
    const tree = buildDiskTree(disk({ files }));
    expect(tree.root.size).toBe(1390);
    expect(tree.root.dirs.get("games")?.size).toBe(350);
    expect(tree.root.dirs.get("games")?.dirs.get("RimWorld")?.size).toBe(150);
    expect(tree.root.dirs.get("games")?.fileCount).toBe(3);
  });

  it("lists children sorted by size descending", () => {
    const page = browseDisk([disk({ files })], "disk-s", "games");
    expect(page.entries[0]?.name).toBe("Hades");
    expect(page.entries[0]?.size).toBe(200);
    expect(page.entries.map((e) => e.name)).toContain("RimWorld");
    expect(page.scopeBytes).toBe(350);
  });

  it("sorts folders by summed bytes, not by how many files they contain", () => {
    const mixed: IndexedFile[] = [
      { relativePath: "small/a.bin", name: "a.bin", kind: "file", size: 10, mtimeMs: 1, sidecarCategory: null, categories: [] },
      { relativePath: "small/b.bin", name: "b.bin", kind: "file", size: 10, mtimeMs: 1, sidecarCategory: null, categories: [] },
      { relativePath: "small/c.bin", name: "c.bin", kind: "file", size: 10, mtimeMs: 1, sidecarCategory: null, categories: [] },
      { relativePath: "big/movie.mkv", name: "movie.mkv", kind: "file", size: 5_000, allocated: 8_192, mtimeMs: 1, sidecarCategory: null, categories: [] },
    ];
    const page = browseDisk([disk({ files: mixed })], "disk-s", "");
    expect(page.entries.map((entry) => entry.name)).toEqual(["big", "small"]);
    expect(page.entries[0]?.size).toBe(5_000);
    expect(page.entries[0]?.allocated).toBe(8_192);
    expect(page.entries[0]?.fileCount).toBe(1);
    expect(page.entries[1]?.size).toBe(30);
    expect(page.entries[1]?.fileCount).toBe(3);
    expect(page.scopeBytes).toBe(5_030);
  });

  it("does not invent folder savings when one file has no measured on-disk size", () => {
    const mixed: IndexedFile[] = [
      { relativePath: "Games/a.bin", name: "a.bin", kind: "file", size: 1_000, onDisk: 400, compression: "wof", mtimeMs: 1, sidecarCategory: null, categories: [] },
      { relativePath: "Games/b.bin", name: "b.bin", kind: "file", size: 1_000, mtimeMs: 1, sidecarCategory: null, categories: [] },
    ];
    const page = browseDisk([disk({ files: mixed })], "disk-s", "");
    expect(page.entries[0]?.size).toBe(2_000);
    expect(page.entries[0]?.onDisk).toBeNull();
    const known: IndexedFile[] = [
      { relativePath: "Games/a.bin", name: "a.bin", kind: "file", size: 1_000, onDisk: 400, compression: "wof", mtimeMs: 1, sidecarCategory: null, categories: [] },
      { relativePath: "Games/b.bin", name: "b.bin", kind: "file", size: 1_000, onDisk: 1_000, mtimeMs: 1, sidecarCategory: null, categories: [] },
    ];
    const summed = browseDisk([disk({ indexRevision: "known", files: known })], "disk-s", "");
    expect(summed.entries[0]?.onDisk).toBe(1_400);
    expect(summed.entries[0]?.compression).toBe("wof");
  });

  it("shows a connected empty disk, including Z:, and skips an offline empty placeholder", () => {
    const c = disk({
      id: "disk-c",
      label: "System",
      lastMountPath: "C:\\",
      files: [{ relativePath: "Users/a.txt", name: "a.txt", kind: "file", size: 1, mtimeMs: 1, sidecarCategory: null, categories: [] }],
    });
    const z = disk({
      id: "disk-z",
      label: "Data",
      lastMountPath: "Z:\\",
      files: [],
      connectedHosts: [{ id: "windows-pc", name: "Windows PC", os: "win32", elevated: true, mountPaths: ["Z:\\"] }],
    });
    const offline = disk({ id: "disk-off", label: "Spare", lastMountPath: "E:\\", files: [] });
    const roots = browseRoots([c, disk({ files }), z, offline]);
    const names = roots.entries.map((e) => e.name);
    expect(names).toContain("C:");
    expect(names).toContain("S:");
    expect(names).toContain("Z:");
    expect(names).not.toContain("E:");
    expect(browseDisk([z], "disk-z", "").entries).toEqual([]);
  });

  it("is case-sensitive on path segments when browsing", () => {
    const mixed: IndexedFile[] = [
      { relativePath: "Games/A.txt", name: "A.txt", kind: "file", size: 1, mtimeMs: 1, sidecarCategory: null, categories: [] },
      { relativePath: "games/B.txt", name: "B.txt", kind: "file", size: 2, mtimeMs: 1, sidecarCategory: null, categories: [] },
    ];
    const page = browseDisk([disk({ files: mixed })], "disk-s", "");
    const names = page.entries.map((e) => e.name).sort();
    expect(names).toEqual(["Games", "games"]);
    expect(browseDisk([disk({ files: mixed })], "disk-s", "Games").entries[0]?.name).toBe("A.txt");
    expect(browseDisk([disk({ files: mixed })], "disk-s", "games").entries[0]?.name).toBe("B.txt");
  });

  it("paginates with cursor", () => {
    const many: IndexedFile[] = Array.from({ length: 30 }, (_, i) => ({
      relativePath: `f${String(i).padStart(2, "0")}.bin`,
      name: `f${String(i).padStart(2, "0")}.bin`,
      kind: "file" as const,
      size: 30 - i,
      mtimeMs: i,
      sidecarCategory: null,
      categories: [],
    }));
    const first = browseDisk([disk({ files: many })], "disk-s", "", 10, 0);
    expect(first.entries).toHaveLength(10);
    expect(first.nextCursor).toBe(10);
    const second = browseDisk([disk({ files: many })], "disk-s", "", 10, 10);
    expect(second.entries[0]?.name).not.toBe(first.entries[0]?.name);
  });
});
