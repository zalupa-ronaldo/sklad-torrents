import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertReadOnlyCommands, assertSpawnAllowed, planIndexCommands } from "@/addons/drives/commands";
import { executeIndexPlan } from "@/addons/drives/execute-index";
import { applyIndexUpdate, emptyScan } from "@/addons/drives/index-apply";
import { normalizeSerial, normalizeUuid } from "@/addons/drives/identity";
import { DEFAULT_LIBRARIES } from "@/addons/drives/libraries";
import { buildMockCatalog, MOCK_ARCHIVE, MOCK_BACKUP, MOCK_GAMES, MOCK_VAULT } from "@/addons/drives/mock-source";
import { decodeRunlist, filesFromRecords, parseBootSector, readNtfsVolume } from "@/addons/drives/ntfs-mft";
import { parseDiskutil } from "@/addons/drives/diskutil";
import { online, reconcileCatalog } from "@/addons/drives/reconcile";
import { searchDisks } from "@/addons/drives/search";
import { selectIndexStrategy } from "@/addons/drives/strategy";
import type { DiskRecord, HostObservation, IndexedFile, ObservedVolume } from "@/addons/drives/types";
import { parseFsutilUsn } from "@/addons/drives/usn";
import { WINDOWS_VOLUME_SCRIPT } from "@/addons/drives/win-script";
import { parseWindowsVolumes } from "@/addons/drives/win-volumes";

const libs = DEFAULT_LIBRARIES;

function volume(partial: Partial<ObservedVolume> & Pick<ObservedVolume, "serial" | "volumeUuid" | "filesystem">): ObservedVolume {
  return {
    volumeName: partial.volumeName ?? "Disk",
    mountPaths: partial.mountPaths ?? [],
    totalBytes: partial.totalBytes ?? 1000,
    freeBytes: partial.freeBytes ?? 100,
    busy: partial.busy ?? false,
    index: partial.index,
    serial: partial.serial,
    volumeUuid: partial.volumeUuid,
    filesystem: partial.filesystem,
  };
}

function host(partial: Partial<HostObservation> & Pick<HostObservation, "os" | "volumes">): HostObservation {
  return {
    hostId: partial.hostId ?? (partial.os === "win32" ? "windows-pc" : "mac-mini"),
    hostName: partial.hostName ?? (partial.os === "win32" ? "Windows PC" : "Mac mini"),
    elevated: partial.elevated ?? false,
    os: partial.os,
    volumes: partial.volumes,
  };
}

function file(relativePath: string): IndexedFile {
  return {
    relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    kind: "file",
    size: 10,
    mtimeMs: 1,
    sidecarCategory: null,
    categories: [],
  };
}

describe("disk identity", () => {
  it("treats a changed mount path as the same serial and UUID", () => {
    let disks = reconcileCatalog(
      [],
      [host({ os: "win32", volumes: [volume({ serial: "WD-1", volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", filesystem: "NTFS", mountPaths: ["D:\\"] })] })],
      libs,
      "2026-01-01T00:00:00.000Z",
    );
    const id = disks[0].id;
    disks = reconcileCatalog(
      disks,
      [host({ os: "win32", volumes: [volume({ serial: "wd 1", volumeUuid: "{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}", filesystem: "NTFS", mountPaths: ["E:\\"] })] })],
      libs,
      "2026-02-01T00:00:00.000Z",
    );
    expect(disks).toHaveLength(1);
    expect(disks[0].id).toBe(id);
    expect(disks[0].lastMountPath).toBe("E:\\");
    expect(disks[0].priorMountPath).toBe("D:\\");
    expect(online(disks[0])).toBe(true);
  });

  it("keeps one catalog when the Mac mount path gains a suffix", () => {
    const disks = buildMockCatalog(libs);
    const vaults = disks.filter((disk) => disk.serial === MOCK_VAULT.serial);
    expect(vaults).toHaveLength(1);
    expect(vaults[0].lastMountPath).toBe("/Volumes/vault 1");
    expect(vaults[0].priorMountPath).toBe("/Volumes/vault");
    expect(vaults[0].possibleClone).toBe(false);
  });

  it("flags a clone with the same UUID and a different serial", () => {
    const disks = reconcileCatalog(
      [],
      [
        host({
          os: "darwin",
          volumes: [
            volume({ serial: "SERIAL-A", volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", filesystem: "APFS", volumeName: "Original", mountPaths: ["/Volumes/a"] }),
            volume({ serial: "SERIAL-B", volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", filesystem: "APFS", volumeName: "Clone", mountPaths: ["/Volumes/b"] }),
          ],
        }),
      ],
      libs,
      "2026-03-01T00:00:00.000Z",
    );
    expect(disks).toHaveLength(2);
    expect(disks.every((disk) => disk.possibleClone)).toBe(true);
    expect(new Set(disks.map((disk) => disk.id)).size).toBe(2);
  });

  it("does not merge a missing serial with the same UUID", () => {
    let disks = reconcileCatalog(
      [],
      [host({ os: "darwin", volumes: [volume({ serial: "", volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", filesystem: "APFS", mountPaths: ["/Volumes/one"] })] })],
      libs,
      "2026-03-01T00:00:00.000Z",
    );
    disks = reconcileCatalog(disks, [host({ os: "darwin", volumes: [] })], libs, "2026-03-02T00:00:00.000Z");
    disks = reconcileCatalog(
      disks,
      [host({ os: "darwin", volumes: [volume({ serial: "", volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", filesystem: "APFS", mountPaths: ["/Volumes/two"] })] })],
      libs,
      "2026-03-03T00:00:00.000Z",
    );
    expect(disks).toHaveLength(2);
    expect(disks.every((disk) => disk.possibleClone)).toBe(true);
    expect(normalizeSerial("")).toBe("");
    expect(normalizeUuid("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe(normalizeUuid("{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}"));
  });

  it("marks two mount points of one serial and UUID as duplicate mounts", () => {
    const disks = reconcileCatalog(
      [],
      [
        host({
          os: "darwin",
          volumes: [
            volume({
              serial: "SERIAL-A",
              volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              filesystem: "APFS",
              mountPaths: ["/Volumes/vault", "/Volumes/vault 1"],
            }),
          ],
        }),
      ],
      libs,
      "2026-03-01T00:00:00.000Z",
    );
    expect(disks).toHaveLength(1);
    expect(disks[0].duplicateMounts).toBe(true);
    expect(disks[0].connectedHosts[0].mountPaths).toEqual(["/Volumes/vault", "/Volumes/vault 1"]);
  });
});

describe("shelf retention and search", () => {
  it("keeps an unplugged disk and tells which label to connect", () => {
    const disks = buildMockCatalog(libs);
    const archive = disks.find((disk) => disk.serial === MOCK_ARCHIVE.serial);
    expect(archive).toBeTruthy();
    expect(online(archive as DiskRecord)).toBe(false);
    expect(archive?.files.length).toBeGreaterThan(0);
    const hits = searchDisks(disks, "день рождения");
    expect(hits).toHaveLength(1);
    expect(hits[0].online).toBe(false);
    expect(hits[0].reachable).toBe(false);
    expect(hits[0].connectHint).toBe("Подключите диск «Архив 2019»");
    expect(hits[0].label).toBe("Архив 2019");
    expect(hits[0].serial).toBe(MOCK_ARCHIVE.serial);
    expect(hits[0].filesystem).toBe("NTFS");
    expect(hits[0].path).toMatch(/день рождения\.mp4$/);
    expect(hits[0].categories).toEqual(expect.arrayContaining(["media", "torrent"]));
  });

  it("tags games and media on disks that are online", () => {
    const disks = buildMockCatalog(libs);
    const vault = disks.find((disk) => disk.serial === MOCK_VAULT.serial)!;
    const movie = vault.files.find((entry) => entry.name.includes("Interstellar"));
    const game = vault.files.find((entry) => entry.relativePath.includes("ULUS10479"));
    expect(movie?.categories).toContain("media");
    expect(game?.categories).toContain("game");
    expect(disks.find((disk) => disk.serial === MOCK_GAMES.serial)?.scan.strategy).toBe("walk");
    expect(disks.find((disk) => disk.serial === MOCK_GAMES.serial)?.scan.message).toMatch(/администратор/);
    expect(vault.scan.strategy).toBe("walk");
    expect(vault.scan.message).toMatch(/MFT не используется/);
    expect(disks.find((disk) => disk.serial === MOCK_BACKUP.serial)?.namedByUser).toBe(false);
  });

  it("does not delete indexed files when a scan fails, pauses, or is still running", () => {
    const previous = [file("Archive/keep.jpg"), file("Archive/gone.jpg")];
    for (const state of ["error", "paused", "running"] as const) {
      const applied = applyIndexUpdate({
        previous,
        previousScan: emptyScan(),
        update: { state, progress: 0.2, files: [file("Archive/keep.jpg")], message: "сбой" },
        busy: false,
        libraries: libs,
        pathStyle: "win32",
        mountPath: "E:\\",
        filesystem: "NTFS",
        platform: "win32",
        elevated: false,
      });
      expect(applied.applied).toBe("kept");
      expect(applied.files.map((entry) => entry.relativePath)).toEqual(["Archive/keep.jpg", "Archive/gone.jpg"]);
    }
    const busy = applyIndexUpdate({
      previous,
      previousScan: { ...emptyScan(), status: "complete", progress: 1 },
      update: { state: "complete", progress: 1, files: [] },
      busy: true,
      libraries: libs,
      pathStyle: "win32",
      mountPath: "E:\\",
      filesystem: "NTFS",
      platform: "win32",
      elevated: true,
    });
    expect(busy.scan.status).toBe("paused");
    expect(busy.files).toHaveLength(2);
  });

  it("drops a file only after a complete successful rescan or USN delta", () => {
    const previous = [file("Archive/keep.jpg"), file("Archive/gone.jpg")];
    const replaced = applyIndexUpdate({
      previous,
      previousScan: emptyScan(),
      update: { state: "complete", progress: 1, files: [file("Archive/keep.jpg"), file("Archive/new.jpg")] },
      busy: false,
      libraries: libs,
      pathStyle: "win32",
      mountPath: "E:\\",
      filesystem: "NTFS",
      platform: "win32",
      elevated: true,
    });
    expect(replaced.files.map((entry) => entry.relativePath).sort()).toEqual(["Archive/keep.jpg", "Archive/new.jpg"]);
    const partial = applyIndexUpdate({
      previous,
      previousScan: emptyScan(),
      update: { state: "complete", progress: 1, delta: { upserts: [], deletes: ["Archive/gone.jpg"], complete: false } },
      busy: false,
      libraries: libs,
      pathStyle: "win32",
      mountPath: "E:\\",
      filesystem: "NTFS",
      platform: "win32",
      elevated: true,
    });
    expect(partial.files).toHaveLength(2);
    const delta = applyIndexUpdate({
      previous,
      previousScan: emptyScan(),
      update: { state: "complete", progress: 1, delta: { upserts: [file("Archive/fresh.jpg")], deletes: ["Archive/gone.jpg"], complete: true } },
      busy: false,
      libraries: libs,
      pathStyle: "win32",
      mountPath: "E:\\",
      filesystem: "NTFS",
      platform: "win32",
      elevated: true,
    });
    expect(delta.applied).toBe("delta");
    expect(delta.files.map((entry) => entry.relativePath).sort()).toEqual(["Archive/fresh.jpg", "Archive/keep.jpg"]);
  });
});

describe("read-only indexer", () => {
  it("uses MFT/USN only for elevated Windows NTFS", () => {
    expect(selectIndexStrategy({ filesystem: "NTFS", platform: "win32", elevated: true }).strategy).toBe("mft-usn");
    expect(selectIndexStrategy({ filesystem: "NTFS", platform: "win32", elevated: false }).strategy).toBe("walk");
    expect(selectIndexStrategy({ filesystem: "APFS", platform: "darwin", elevated: true }).strategy).toBe("walk");
    expect(selectIndexStrategy({ filesystem: "APFS", platform: "win32", elevated: true }).strategy).toBe("walk");
    expect(selectIndexStrategy({ filesystem: "HFS+", platform: "darwin", elevated: true }).strategy).toBe("walk");
    expect(selectIndexStrategy({ filesystem: "exFAT", platform: "win32", elevated: true }).strategy).toBe("walk");
    expect(selectIndexStrategy({ filesystem: "NTFS", platform: "darwin", elevated: true }).strategy).toBe("walk");
  });

  it("plans no destructive operations", () => {
    const plans = [
      planIndexCommands({ filesystem: "APFS", platform: "darwin", elevated: true, busy: false, usnCheckpoint: false }),
      planIndexCommands({ filesystem: "NTFS", platform: "win32", elevated: true, busy: false, usnCheckpoint: true }),
      planIndexCommands({ filesystem: "NTFS", platform: "win32", elevated: false, busy: false, usnCheckpoint: false }),
      planIndexCommands({ filesystem: "exFAT", platform: "win32", elevated: true, busy: false, usnCheckpoint: false }),
      planIndexCommands({ filesystem: "HFS+", platform: "darwin", elevated: false, busy: true, usnCheckpoint: false }),
    ];
    const banned = /\b(format|mkfs|diskpart|chkdsk|compact|compress|erase|initialize|repair|delete|move|mountvol|assign|dismount)\b/i;
    for (const commands of plans) {
      assertReadOnlyCommands(commands);
      expect(JSON.stringify(commands)).not.toMatch(banned);
      expect(commands.every((command) => ["identify-volume", "stat-volume", "walk", "read-mft", "read-usn", "pause", "resume"].includes(command.op))).toBe(true);
    }
    expect(plans[0].map((command) => command.op)).toEqual(["identify-volume", "stat-volume", "walk"]);
    expect(plans[1].map((command) => command.op)).toEqual(["identify-volume", "stat-volume", "read-mft", "read-usn"]);
    expect(plans[4]).toEqual([{ op: "pause", reason: "disk-busy" }]);
    expect(() => assertSpawnAllowed({ bin: "format.com", args: ["E:"] })).toThrow();
    expect(() => assertSpawnAllowed({ bin: "fsutil", args: ["usn", "createJournal", "E:"] })).toThrow();
    expect(() => assertSpawnAllowed({ bin: "diskutil", args: ["eraseDisk", "disk0"] })).toThrow();
    expect(() => assertSpawnAllowed({ bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Clear-Disk"] })).toThrow();
    expect(() => assertSpawnAllowed({ bin: "diskutil", args: ["info", "-all"] })).not.toThrow();
    expect(() => assertSpawnAllowed({ bin: "fsutil", args: ["usn", "queryJournal", "E:"] })).not.toThrow();
    expect(() => assertSpawnAllowed({ bin: "fsutil", args: ["usn", "readJournal", "E:", "120"] })).not.toThrow();
    expect(() =>
      assertSpawnAllowed({ bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_VOLUME_SCRIPT] }),
    ).not.toThrow();
  });

  it("calls only walk for APFS and only MFT/USN for elevated NTFS", async () => {
    const calls: string[] = [];
    const handlers = {
      readMft: async () => {
        calls.push("readMft");
        return { files: [file("Cinema/a.mkv")], complete: true };
      },
      readUsn: async () => {
        calls.push("readUsn");
        return { delta: null };
      },
      walk: async () => {
        calls.push("walk");
        return { files: [file("Cinema/a.mkv")], complete: true };
      },
    };
    const apfs = await executeIndexPlan(
      { filesystem: "APFS", platform: "darwin", elevated: true, busy: false, usnCheckpoint: false },
      handlers,
    );
    expect(apfs.called).toEqual(["walk"]);
    expect(apfs.payload.strategy).toBe("walk");
    calls.length = 0;
    const ntfs = await executeIndexPlan(
      { filesystem: "NTFS", platform: "win32", elevated: true, busy: false, usnCheckpoint: false },
      handlers,
    );
    expect(ntfs.called).toEqual(["readMft", "readUsn"]);
    expect(ntfs.payload.files?.length).toBe(1);
    const paused = await executeIndexPlan(
      { filesystem: "NTFS", platform: "win32", elevated: true, busy: true, usnCheckpoint: false },
      handlers,
    );
    expect(paused.called).toEqual([]);
    expect(paused.payload.state).toBe("paused");
    const failed = await executeIndexPlan(
      { filesystem: "APFS", platform: "darwin", elevated: true, busy: false, usnCheckpoint: false },
      { ...handlers, walk: async () => ({ files: [], complete: false }) },
    );
    expect(failed.payload.state).toBe("error");
    expect(failed.payload.files).toBeUndefined();
  });

  it("keeps indexer sources free of destructive commands", () => {
    const roots = [
      path.join(process.cwd(), "agents/lib"),
      path.join(process.cwd(), "agents/mac-agent"),
      path.join(process.cwd(), "src/addons/drives"),
    ];
    const extra = [
      path.join(process.cwd(), "agents/pc-agent/drive.mts"),
      path.join(process.cwd(), "agents/pc-agent/collect.mts"),
    ];
    const banned = [
      "Format-Volume",
      "Initialize-Disk",
      "Clear-Disk",
      "Remove-Item",
      "mountvol",
      "diskpart",
      "chkdsk",
      "createJournal",
      "deleteJournal",
      "compact.exe",
      "diskutil erase",
      "diskutil mount",
      "Repair-Volume",
    ];
    const files = extra.concat(roots.flatMap((root) => listFiles(root)));
    for (const filePath of files) {
      if (filePath.endsWith(".test.ts") || filePath.endsWith(`${path.sep}commands.ts`)) continue;
      const text = readFileSync(filePath, "utf8");
      for (const token of banned) {
        expect(text.includes(token), `${filePath} contains ${token}`).toBe(false);
      }
    }
    const mac = readFileSync(path.join(process.cwd(), "agents/mac-agent/drive.mts"), "utf8");
    expect(mac.includes("fsutil")).toBe(false);
    expect(mac.includes("readNtfs")).toBe(false);
  });
});

describe("collectors and NTFS reader", () => {
  it("parses diskutil identity without using the mount path as identity", () => {
    const volumes = parseDiskutil(`
Device Identifier:         disk3
Device / Media Serial Number: WD-WCAV12345678
Whole:                     Yes
Part of Whole:             disk3

Device Identifier:         disk4
Whole:                     Yes
Part of Whole:             disk3

Device Identifier:         disk4s1
Whole:                     No
Part of Whole:             disk4
Volume Name:               Vault
Mount Point:               /Volumes/vault 1
File System Personality:   APFS
Volume UUID:               A1B2C3D4-1111-4AAA-8BBB-111111111111
Disk Size:                 4.0 TB (4000000000000 Bytes)
Volume Free Space:         1.2 TB (1200000000000 Bytes)
`);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].serial).toBe("WD-WCAV12345678");
    expect(volumes[0].volumeUuid).toBe("A1B2C3D4-1111-4AAA-8BBB-111111111111");
    expect(volumes[0].filesystem).toBe("APFS");
    expect(volumes[0].mountPaths).toEqual(["/Volumes/vault 1"]);
  });

  it("parses Windows volumes and a busy letter", () => {
    const parsed = parseWindowsVolumes({
      admin: false,
      disks: [{ Index: 1, SerialNumber: "ST4000DM-ARCH2019" }],
      parts: [{ DiskNumber: 1, DriveLetter: "E" }],
      vols: [
        {
          DriveLetter: "E",
          FileSystem: "NTFS",
          FileSystemLabel: "ARCHIVE",
          Size: 4000,
          SizeRemaining: 800,
          UniqueId: "\\\\?\\Volume{b2c3d4e5-2222-4bbb-8ccc-222222222222}\\",
        },
      ],
      perf: [{ Name: "E:", PercentDiskTime: 91 }],
    });
    expect(parsed.elevated).toBe(false);
    expect(parsed.volumes[0].serial).toBe("ST4000DM-ARCH2019");
    expect(parsed.volumes[0].busy).toBe(true);
    expect(parsed.volumes[0].mountPaths).toEqual(["E:\\"]);
    expect(normalizeUuid(parsed.volumes[0].volumeUuid)).toBe("b2c3d4e522224bbb8ccc222222222222");
  });

  it("reads a synthetic NTFS file tree and a USN delete", async () => {
    const records = [makeRecord({ parent: 5, name: "$MFT", directory: true }), makeRecord({ parent: 5, name: "Cinema", directory: true }), makeRecord({ parent: 1, name: "movie.mkv", size: 100 })];
    const files = filesFromRecords(records, 1024, 512);
    expect(files.map((entry) => entry.relativePath)).toEqual(["Cinema", "Cinema/movie.mkv"]);
    expect(files[1].size).toBe(100);
    const boot = Buffer.alloc(512);
    boot.write("NTFS    ", 3, "latin1");
    boot.writeUInt16LE(512, 0x0b);
    boot.writeUInt8(1, 0x0d);
    boot.writeBigUInt64LE(4n, 0x30);
    boot.writeInt8(-10, 0x40);
    expect(parseBootSector(boot)?.recordSize).toBe(1024);
    const disk = Buffer.alloc(2048 + records.length * 1024);
    boot.copy(disk, 0);
    records.forEach((record, index) => record.copy(disk, 2048 + index * 1024));
    const read = await readNtfsVolume(async (offset, length) => {
      const buffer = Buffer.alloc(length);
      if (offset < disk.length) disk.copy(buffer, 0, offset, Math.min(disk.length, offset + length));
      return buffer;
    });
    expect(read.complete).toBe(true);
    expect(read.files.some((entry) => entry.relativePath === "Cinema/movie.mkv")).toBe(true);
    const sized = filesFromRecords(
      [
        makeRecord({ parent: 5, name: "movie.mkv", size: 0, data: { size: 5_000, allocated: 8_192 } }),
        makeRecord({ parent: 5, name: "note.txt", size: 99, data: { size: 4, allocated: 4, resident: true } }),
        makeRecord({ parent: 5, name: "sparse.bin", size: 0 }),
        makeRecord({ parent: 5, name: "big.mkv", size: 0 }),
        makeRecord({ name: "", base: 3, data: { size: 9_000, allocated: 12_288 } }),
      ],
      1024,
      512,
    );
    expect(sized.find((entry) => entry.name === "movie.mkv")).toMatchObject({ size: 5_000, allocated: 8_192 });
    expect(sized.find((entry) => entry.name === "note.txt")).toMatchObject({ size: 4, allocated: 4 });
    expect(sized.find((entry) => entry.name === "sparse.bin")?.size).toBe(0);
    expect(sized.find((entry) => entry.name === "sparse.bin")?.allocated).toBeUndefined();
    expect(sized.find((entry) => entry.name === "big.mkv")).toMatchObject({ size: 9_000, allocated: 12_288 });
    const wof = filesFromRecords(
      [
        makeRecord({
          parent: 5,
          name: "pack.bin",
          size: 0,
          data: { size: 10_000, allocated: 10_000 },
          wof: { size: 2_000, allocated: 4_096 },
        }),
        makeRecord({
          parent: 5,
          name: "tagged.bin",
          size: 0,
          data: { size: 10_000, allocated: 10_000 },
          reparseWof: true,
        }),
      ],
      1024,
      512,
    );
    expect(wof.find((entry) => entry.name === "pack.bin")).toMatchObject({ size: 10_000, allocated: 10_000, onDisk: 2_000, compression: "wof" });
    expect(wof.find((entry) => entry.name === "tagged.bin")?.onDisk).toBeUndefined();
    expect(wof.find((entry) => entry.name === "tagged.bin")?.compression).toBe("wof");
    expect(decodeRunlist(Buffer.from([0x11, 0x04, 0x0a, 0x00]))).toEqual([{ lcn: 10, length: 4 }]);
    const delta = parseFsutilUsn("File name: Cinema/movie.mkv\nReason: 0x80000100\n");
    expect(delta.complete).toBe(true);
    expect(delta.deletes).toEqual(["Cinema/movie.mkv"]);
  });
});

function makeRecord(options: {
  parent?: number;
  name: string;
  directory?: boolean;
  size?: number;
  /** Non-zero base file reference: this record is an extension of that MFT index. */
  base?: number;
  data?: { size: number; allocated: number; resident?: boolean };
  wof?: { size: number; allocated: number };
  reparseWof?: boolean;
}): Buffer {
  const record = Buffer.alloc(1024);
  record.write("FILE", 0, "latin1");
  record.writeUInt16LE(0x30, 4);
  record.writeUInt16LE(1, 6);
  record.writeUInt16LE(0x38, 0x14);
  record.writeUInt16LE(options.directory ? 0x03 : 0x01, 0x16);
  if (options.base) record.writeUInt32LE(options.base, 0x20);
  let cursor = 0x38;
  if (options.name) {
    const name = Buffer.from(options.name, "utf16le");
    const valueLength = 0x42 + name.length;
    const padded = Math.ceil((0x18 + valueLength) / 8) * 8;
    record.writeUInt32LE(0x30, cursor);
    record.writeUInt32LE(padded, cursor + 4);
    record.writeUInt32LE(valueLength, cursor + 0x10);
    record.writeUInt16LE(0x18, cursor + 0x14);
    const value = cursor + 0x18;
    record.writeUInt32LE(options.parent ?? 0, value);
    record.writeBigUInt64LE(BigInt(options.size ?? 0), value + 0x30);
    record.writeUInt8(options.name.length, value + 0x40);
    record.writeUInt8(1, value + 0x41);
    name.copy(record, value + 0x42);
    cursor += padded;
  }
  if (options.data) {
    if (options.data.resident) {
      const length = 0x18;
      record.writeUInt32LE(0x80, cursor);
      record.writeUInt32LE(length, cursor + 4);
      record.writeUInt8(0, cursor + 8);
      record.writeUInt32LE(options.data.size, cursor + 0x10);
      record.writeUInt16LE(0x18, cursor + 0x14);
      cursor += length;
    } else {
      const length = 0x40;
      record.writeUInt32LE(0x80, cursor);
      record.writeUInt32LE(length, cursor + 4);
      record.writeUInt8(1, cursor + 8);
      record.writeBigUInt64LE(BigInt(options.data.allocated), cursor + 0x28);
      record.writeBigUInt64LE(BigInt(options.data.size), cursor + 0x30);
      cursor += length;
    }
  }
  if (options.wof) {
    const name = Buffer.from("WofCompressedData", "utf16le");
    const nameOffset = 0x40;
    const length = Math.ceil((nameOffset + name.length) / 8) * 8;
    record.writeUInt32LE(0x80, cursor);
    record.writeUInt32LE(length, cursor + 4);
    record.writeUInt8(1, cursor + 8);
    record.writeUInt8(name.length / 2, cursor + 9);
    record.writeUInt16LE(nameOffset, cursor + 0x0a);
    record.writeBigUInt64LE(BigInt(options.wof.allocated), cursor + 0x28);
    record.writeBigUInt64LE(BigInt(options.wof.size), cursor + 0x30);
    name.copy(record, cursor + nameOffset);
    cursor += length;
  }
  if (options.reparseWof) {
    const length = 0x18 + 8;
    record.writeUInt32LE(0xc0, cursor);
    record.writeUInt32LE(length, cursor + 4);
    record.writeUInt8(0, cursor + 8);
    record.writeUInt32LE(8, cursor + 0x10);
    record.writeUInt16LE(0x18, cursor + 0x14);
    record.writeUInt32LE(0x80000017, cursor + 0x18);
    cursor += length;
  }
  record.writeUInt32LE(0xffffffff, cursor);
  return record;
}

function listFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...listFiles(full));
    else found.push(full);
  }
  return found;
}
