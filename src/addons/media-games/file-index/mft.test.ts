import { describe, expect, it } from "vitest";

import { MemoryFileIndex } from "@/addons/media-games/file-index/memory";
import { encodeMftFixture, parseMftFixture } from "@/addons/media-games/file-index/mft";

describe("synthetic MFT fixtures", () => {
  it("reconstructs nested paths from parent indexes", async () => {
    const fixture = encodeMftFixture([
      { recordNumber: 5, parentRecord: 5, isDirectory: true, name: "." },
      { recordNumber: 100, parentRecord: 5, isDirectory: true, name: "Games" },
      { recordNumber: 101, parentRecord: (9n << 48n) | 100n, isDirectory: true, name: "Hades" },
      { recordNumber: 102, parentRecord: 101, size: 4096, name: "Hades.exe" },
      { recordNumber: 103, parentRecord: 101, isDirectory: true, name: "Content" },
      { recordNumber: 104, parentRecord: 103, size: 99, name: "data.pkg" },
      { recordNumber: 200, parentRecord: 100, inUse: false, name: "Ghost" },
    ]);

    const parsed = parseMftFixture(fixture);
    expect(parsed.find((entry) => entry.name === "Hades")?.parentRecord).toBe(100n);
    expect(parsed.find((entry) => entry.name === "Ghost")?.inUse).toBe(false);

    const index = new MemoryFileIndex();
    const status = await index.indexVolume({
      host: "Windows PC",
      volume: "D:",
      os: "win32",
      filesystem: "ntfs",
      elevated: true,
      mftFixture: fixture,
    });

    expect(status.source).toBe("mft");
    expect(status.elevated).toBe(true);
    expect(status.fileCount).toBe(5);
    expect(index.search("Ghost")).toEqual([]);

    const exe = index.search("Hades.exe");
    expect(exe).toHaveLength(1);
    expect(exe[0]).toMatchObject({
      host: "Windows PC",
      path: "D:\\Games\\Hades\\Hades.exe",
      name: "Hades.exe",
      size: 4096,
      isDirectory: false,
      source: "mft",
      volume: "D:",
    });
    expect(index.search("data.pkg")[0]?.path).toBe("D:\\Games\\Hades\\Content\\data.pkg");
    expect(index.search("Hades", { directoriesOnly: true }).map((hit) => hit.path)).toContain("D:\\Games\\Hades");
  });

  it("reads a hand-built FILE record at the documented offsets", () => {
    const name = Buffer.from("Games", "utf16le");
    const buf = Buffer.alloc(28 + name.length);
    buf.write("FILE", 0, "ascii");
    buf.writeUInt32LE(100, 4);
    buf.writeBigUInt64LE(5n, 8);
    buf.writeBigUInt64LE(0n, 16);
    buf.writeUInt16LE(0x0003, 24);
    buf.writeUInt16LE(name.length / 2, 26);
    name.copy(buf, 28);

    const rootName = Buffer.from(".", "utf16le");
    const root = Buffer.alloc(28 + rootName.length);
    root.write("FILE", 0, "ascii");
    root.writeUInt32LE(5, 4);
    root.writeBigUInt64LE(5n, 8);
    root.writeUInt16LE(0x0003, 24);
    root.writeUInt16LE(rootName.length / 2, 26);
    rootName.copy(root, 28);

    const [rootEntry, games] = parseMftFixture(Buffer.concat([root, buf]));
    expect(rootEntry).toMatchObject({ recordNumber: 5n, parentRecord: 5n, isDirectory: true, name: "." });
    expect(games).toMatchObject({ recordNumber: 100n, parentRecord: 5n, isDirectory: true, name: "Games" });
  });
});
