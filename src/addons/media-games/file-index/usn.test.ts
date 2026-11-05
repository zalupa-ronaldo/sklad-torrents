import { describe, expect, it } from "vitest";

import { MemoryFileIndex } from "@/addons/media-games/file-index/memory";
import { encodeUsnJournal, encodeUsnRecord, parseUsnRecords, UsnReason } from "@/addons/media-games/file-index/usn";
import type { IndexVolumeRequest } from "@/addons/media-games/file-index/types";

const volume: IndexVolumeRequest = {
  host: "Windows PC",
  volume: "D:",
  os: "win32",
  filesystem: "ntfs",
  elevated: true,
  preferUsn: true,
};

describe("synthetic USN journal", () => {
  it("create, rename, and delete update the in-memory index", async () => {
    const index = new MemoryFileIndex();

    await index.indexVolume({
      ...volume,
      usnJournal: encodeUsnJournal([
        encodeUsnRecord({
          fileRef: 20n,
          parentRef: 5n,
          usn: 10n,
          reason: UsnReason.FILE_CREATE | UsnReason.CLOSE,
          name: "Games",
          isDirectory: true,
        }),
        encodeUsnRecord({
          fileRef: 21n,
          parentRef: 20n,
          usn: 11n,
          reason: UsnReason.FILE_CREATE | UsnReason.CLOSE,
          name: "Hades.exe",
        }),
      ]),
    });

    expect(index.search("Hades.exe")).toEqual([
      expect.objectContaining({
        host: "Windows PC",
        path: "D:\\Games\\Hades.exe",
        source: "usn",
        volume: "D:",
      }),
    ]);
    expect(index.status("D:")[0]).toMatchObject({ source: "usn", elevated: true });

    await index.indexVolume({
      ...volume,
      usnJournal: encodeUsnJournal([
        encodeUsnRecord({
          fileRef: 21n,
          parentRef: 20n,
          usn: 12n,
          reason: UsnReason.RENAME_OLD_NAME | UsnReason.CLOSE,
          name: "Hades.exe",
        }),
        encodeUsnRecord({
          fileRef: 30n,
          parentRef: 5n,
          usn: 13n,
          reason: UsnReason.FILE_CREATE | UsnReason.CLOSE,
          name: "Archive",
          isDirectory: true,
        }),
        encodeUsnRecord({
          fileRef: 21n,
          parentRef: 30n,
          usn: 14n,
          reason: UsnReason.RENAME_NEW_NAME | UsnReason.CLOSE,
          name: "Hades2.exe",
        }),
      ]),
    });

    expect(index.search("Hades.exe")).toEqual([]);
    expect(index.search("Hades2.exe")[0]?.path).toBe("D:\\Archive\\Hades2.exe");

    await index.indexVolume({
      ...volume,
      usnJournal: encodeUsnRecord({
        fileRef: 21n,
        parentRef: 30n,
        usn: 15n,
        reason: UsnReason.FILE_DELETE | UsnReason.CLOSE,
        name: "Hades2.exe",
      }),
    });
    expect(index.search("Hades2.exe")).toEqual([]);
    expect(index.search("Archive")).toHaveLength(1);
  });

  it("deleting a directory drops its children", async () => {
    const index = new MemoryFileIndex();
    await index.indexVolume({
      ...volume,
      usnJournal: encodeUsnJournal([
        encodeUsnRecord({
          fileRef: 40n,
          parentRef: 5n,
          usn: 1n,
          reason: UsnReason.FILE_CREATE,
          name: "Gone",
          isDirectory: true,
        }),
        encodeUsnRecord({
          fileRef: 41n,
          parentRef: 40n,
          usn: 2n,
          reason: UsnReason.FILE_CREATE,
          name: "save.dat",
        }),
      ]),
    });
    await index.indexVolume({
      ...volume,
      usnJournal: encodeUsnRecord({
        fileRef: 40n,
        parentRef: 5n,
        usn: 3n,
        reason: UsnReason.FILE_DELETE,
        name: "Gone",
        isDirectory: true,
      }),
    });
    expect(index.search("save.dat")).toEqual([]);
    expect(index.search("Gone")).toEqual([]);
  });

  it("parses a hand-built USN_RECORD_V2", () => {
    const name = Buffer.from("A", "utf16le");
    const recordLength = 64;
    const buf = Buffer.alloc(recordLength);
    buf.writeUInt32LE(recordLength, 0);
    buf.writeUInt16LE(2, 4);
    buf.writeBigUInt64LE(21n, 8);
    buf.writeBigUInt64LE(5n, 16);
    buf.writeBigInt64LE(7n, 24);
    buf.writeUInt32LE(UsnReason.FILE_CREATE >>> 0, 40);
    buf.writeUInt16LE(name.length, 56);
    buf.writeUInt16LE(60, 58);
    name.copy(buf, 60);
    expect(parseUsnRecords(buf)).toEqual([
      expect.objectContaining({ fileRef: 21n, parentRef: 5n, usn: 7n, reason: UsnReason.FILE_CREATE, name: "A" }),
    ]);
  });
});
