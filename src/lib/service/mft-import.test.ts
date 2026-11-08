import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { requestDiskRescan } from "@/addons/drives/rescan";
import { clearMftCancel, importMftExport, parseVolData2, requestMftCancel } from "@/lib/service/mft-import";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("offline WizTree MFT import", () => {
  it("rejects a truncated footer and does not publish a disk", async () => {
    const dir = await scratch();
    const file = path.join(dir, "short.MFT");
    await writeFile(file, Buffer.alloc(100));
    await expect(importMftExport({ filePath: file, serial: "SYN", volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", directory: dir })).rejects.toThrow(/105/);
    await expect(readFile(path.join(dir, "drives.json"), "utf8")).rejects.toThrow();
  });

  it("keeps a corrupt record out of the ready tree and still imports the valid file", async () => {
    const dir = await scratch();
    const good = record({ name: "keep.txt", parent: 5, data: { size: 40, allocated: 4096 } });
    const corrupt = Buffer.from(good);
    corrupt.writeUInt16LE(0x30, 4);
    corrupt.writeUInt16LE(3, 6);
    corrupt.writeUInt16LE(0x1111, 0x30);
    corrupt.writeUInt16LE(0x2222, 510);
    const result = await importMftExport({
      filePath: await volume(dir, [corrupt, good], "D"),
      serial: "SYN",
      volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      directory: dir,
    });
    expect(result.badRecords).toBe(1);
    expect(result.files).toBe(1);
    expect(result.logicalBytes).toBe(40);
    expect(result.unknownSize).toBe(0);
    expect(result.diskId.startsWith("disk-")).toBe(true);
  });

  it("drops parent cycles, reused sequences, unsafe names, and counts a hardlink once", async () => {
    const dir = await scratch();
    const left = record({ indexHint: 0, name: "left", parent: 1, sequence: 1 });
    const right = record({ indexHint: 1, name: "right", parent: 0, sequence: 1 });
    const stale = record({ name: "stale.txt", parent: 2, parentSequence: 9, sequence: 4, data: { size: 8, allocated: 8 } });
    const parent = record({ name: "dir", parent: 5, directory: true, sequence: 1 });
    const danger = record({ name: "..", parent: 5, data: { size: 1, allocated: 1 } });
    const link = record({
      names: [
        { name: "one.txt", parent: 5 },
        { name: "two.txt", parent: 5 },
      ],
      data: { size: 12, allocated: 4096 },
    });
    const unknown = record({ name: "unknown.bin", parent: 5, size: 0 });
    const result = await importMftExport({
      filePath: await volume(dir, [left, right, parent, stale, danger, link, unknown], "D"),
      serial: "SYN2",
      volumeUuid: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      directory: dir,
    });
    expect(result.cycles).toBeGreaterThan(0);
    expect(result.sequenceMismatch).toBeGreaterThan(0);
    expect(result.unsafe).toBeGreaterThan(0);
    expect(result.hardlinks).toBe(1);
    expect(result.logicalBytes).toBe(12);
    expect(result.unknownSize).toBe(1);
    expect(result.unknownAllocated).toBe(1);
    const catalog = JSON.parse(await readFile(path.join(dir, "drives.json"), "utf8")) as { disks: Array<{ files: unknown[]; summary: { indexedBytes: number } }> };
    expect(catalog.disks).toHaveLength(1);
    expect(catalog.disks[0]?.files).toEqual([]);
    expect(catalog.disks[0]?.summary.indexedBytes).toBe(12);
    const shard = await readFile(path.join(dir, "drive-files", `${result.diskId}.ndjson`), "utf8");
    expect(shard).toContain("one.txt");
    expect(shard).toContain("two.txt");
    expect(shard).not.toContain("\"..\"");
    expect(shard).not.toContain("stale.txt");
  });

  it("merges an extension $DATA record and keeps WOF on disk separate from logical size", async () => {
    const dir = await scratch();
    const base = record({ name: "big.bin", parent: 5 });
    const extension = record({ base: 1, data: { size: 100, allocated: 4096 }, wof: { size: 20, allocated: 20 } });
    const result = await importMftExport({
      filePath: await volume(dir, [Buffer.alloc(1024), base, extension], "D"),
      serial: "SYN3",
      volumeUuid: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      directory: dir,
    });
    expect(result.files).toBe(1);
    expect(result.logicalBytes).toBe(100);
    expect(result.allocatedBytes).toBe(4096);
    expect(result.wof).toBe(1);
    expect(result.unknownSize).toBe(0);
  });

  it("imports Z as a protected offline snapshot and refuses E", async () => {
    const dir = await scratch();
    const file = record({ name: "note.txt", parent: 5, data: { size: 3, allocated: 512 } });
    const imported = await importMftExport({
      filePath: await volume(dir, [file], "Z"),
      serial: "ZSYN",
      volumeUuid: "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      directory: dir,
    });
    expect(imported.protected).toBe(true);
    const catalog = JSON.parse(await readFile(path.join(dir, "drives.json"), "utf8")) as { disks: Array<{ snapshotOnly?: boolean; connectedHosts: string[] }> };
    expect(catalog.disks[0]?.snapshotOnly).toBe(true);
    expect(catalog.disks[0]?.connectedHosts).toEqual([]);
    process.env.SKLAD_DATA_DIR = dir;
    await expect(requestDiskRescan(imported.diskId, fetch)).rejects.toThrow(/офлайн/i);
    await expect(importMftExport({
      filePath: await volume(dir, [file], "E"),
      serial: "ESYN",
      volumeUuid: "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      directory: dir,
    })).rejects.toThrow(/E и F/);
  });

  it("cancel and a crash leave no ready snapshot", async () => {
    const dir = await scratch();
    const file = record({ name: "a.txt", parent: 5, data: { size: 4, allocated: 4 } });
    const exportPath = await volume(dir, [file], "D");
    await requestMftCancel(dir);
    await expect(importMftExport({
      filePath: exportPath,
      serial: "SYN4",
      volumeUuid: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      directory: dir,
    })).rejects.toThrow(/отмен/);
    await expect(readFile(path.join(dir, "drives.json"), "utf8")).rejects.toThrow();
    const progress = JSON.parse(await readFile(path.join(dir, "mft-import.json"), "utf8")) as { ready: boolean; phase: string };
    expect(progress.ready).toBe(false);
    expect(progress.phase).toBe("cancelled");
    await clearMftCancel(dir);
    const crashed = spawnSync(process.execPath, ["--import", "./agents/register.mjs", "agents/sklad.mts", "mft-import", "--file", exportPath, "--serial", "SYN4", "--uuid", "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--json"], {
      cwd: process.cwd(),
      env: { ...process.env, SKLAD_DATA_DIR: dir, SKLAD_MFT_EXIT: "86" },
      encoding: "utf8",
    });
    expect(crashed.status).toBe(86);
    await expect(readFile(path.join(dir, "drives.json"), "utf8")).rejects.toThrow();
  });

  it("repeats one disk and one job, and a scale fixture is not a C: parse", async () => {
    const dir = await scratch();
    const file = record({ name: "a.txt", parent: 5, data: { size: 4, allocated: 8 } });
    const exportPath = await volume(dir, [file], "D");
    const input = { filePath: exportPath, serial: "SYN5", volumeUuid: "11111111-bbbb-4ccc-8ddd-eeeeeeeeeeee", directory: dir };
    const first = await importMftExport(input);
    const second = await importMftExport(input);
    expect(second.diskId).toBe(first.diskId);
    expect(second.jobCreated).toBe(false);
    const jobs = JSON.parse(await readFile(path.join(dir, "jobs.json"), "utf8")) as { jobs: unknown[] };
    expect(jobs.jobs).toHaveLength(1);
    const catalog = JSON.parse(await readFile(path.join(dir, "drives.json"), "utf8")) as { disks: Array<{ fileStore?: string }> };
    expect(catalog.disks).toHaveLength(1);
    const shardBefore = await readFile(catalog.disks[0]?.fileStore || "", "utf8");
    await requestMftCancel(dir);
    await expect(importMftExport(input)).rejects.toThrow(/отмен/);
    const catalogAfter = JSON.parse(await readFile(path.join(dir, "drives.json"), "utf8")) as { disks: unknown[] };
    expect(catalogAfter.disks).toHaveLength(1);
    expect(await readFile(catalog.disks[0]?.fileStore || "", "utf8")).toBe(shardBefore);
    await clearMftCancel(dir);
    const blanks: Uint8Array[] = Array.from({ length: 300 }, () => Buffer.alloc(1024));
    blanks.push(file);
    const wide = await importMftExport({
      filePath: await volume(dir, blanks, "S"),
      serial: "SCALE",
      volumeUuid: "22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      directory: dir,
    });
    expect(wide.records).toBe(301);
    expect(wide.files).toBe(1);
    expect(wide.rss).toBeGreaterThan(0);
    expect(wide.rss).toBeLessThan(512 * 1024 * 1024);
  });
});

describe("VOLDATA2 footer", () => {
  it("reads the measured 105-byte layout", () => {
    const trailer = Buffer.alloc(105);
    trailer.write("VOLDATA2", 0, "latin1");
    trailer.writeUInt32LE(512, 48);
    trailer.writeUInt32LE(4096, 52);
    trailer.writeUInt32LE(1024, 56);
    trailer.writeBigUInt64LE(2048n, 64);
    trailer.writeUInt32LE(2, 80);
    trailer[104] = 0x44;
    expect(parseVolData2(trailer, 2153)).toMatchObject({ letter: "D", mftBytes: 2048, recordSize: 1024 });
  });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sklad-mft-"));
  dirs.push(dir);
  return dir;
}

async function volume(dir: string, records: Uint8Array[], letter: string): Promise<string> {
  const body = Buffer.concat(records.map((item) => {
    const record = Buffer.alloc(1024);
    record.set(item.subarray(0, Math.min(item.length, 1024)));
    return record;
  }));
  const trailer = Buffer.alloc(105);
  trailer.write("VOLDATA2", 0, "latin1");
  trailer.writeUInt32LE(512, 48);
  trailer.writeUInt32LE(4096, 52);
  trailer.writeUInt32LE(1024, 56);
  trailer.writeBigUInt64LE(BigInt(body.length), 64);
  trailer.writeUInt32LE(2, 80);
  trailer[104] = letter.charCodeAt(0);
  const file = path.join(dir, `${letter}-${records.length}.MFT`);
  await writeFile(file, Buffer.concat([body, trailer]));
  return file;
}

function record(options: {
  name?: string;
  names?: Array<{ name: string; parent: number }>;
  parent?: number;
  parentSequence?: number;
  sequence?: number;
  directory?: boolean;
  size?: number;
  base?: number;
  indexHint?: number;
  data?: { size: number; allocated: number };
  wof?: { size: number; allocated: number };
}): Buffer {
  const rec = Buffer.alloc(1024);
  rec.write("FILE", 0, "latin1");
  rec.writeUInt16LE(0x30, 4);
  rec.writeUInt16LE(1, 6);
  rec.writeUInt16LE(0x38, 0x14);
  rec.writeUInt16LE(options.sequence ?? 1, 0x10);
  rec.writeUInt16LE(options.directory ? 0x03 : 0x01, 0x16);
  if (options.base != null) rec.writeUInt32LE(options.base, 0x20);
  let cursor = 0x38;
  const names = options.names ?? (options.name ? [{ name: options.name, parent: options.parent ?? 5 }] : []);
  for (const item of names) {
    const encoded = Buffer.from(item.name, "utf16le");
    const valueLength = 0x42 + encoded.length;
    const padded = Math.ceil((0x18 + valueLength) / 8) * 8;
    rec.writeUInt32LE(0x30, cursor);
    rec.writeUInt32LE(padded, cursor + 4);
    rec.writeUInt32LE(valueLength, cursor + 0x10);
    rec.writeUInt16LE(0x18, cursor + 0x14);
    const value = cursor + 0x18;
    const parentWord = BigInt(item.parent) | (BigInt(options.parentSequence ?? 0) << 48n);
    rec.writeBigUInt64LE(parentWord, value);
    rec.writeBigUInt64LE(BigInt(options.size ?? 0), value + 0x30);
    rec.writeUInt8(item.name.length, value + 0x40);
    rec.writeUInt8(1, value + 0x41);
    encoded.copy(rec, value + 0x42);
    cursor += padded;
  }
  if (options.data) {
    rec.writeUInt32LE(0x80, cursor);
    rec.writeUInt32LE(0x40, cursor + 4);
    rec.writeUInt8(1, cursor + 8);
    rec.writeBigUInt64LE(BigInt(options.data.allocated), cursor + 0x28);
    rec.writeBigUInt64LE(BigInt(options.data.size), cursor + 0x30);
    cursor += 0x40;
  }
  if (options.wof) {
    const name = Buffer.from("WofCompressedData", "utf16le");
    const length = Math.ceil((0x40 + name.length) / 8) * 8;
    rec.writeUInt32LE(0x80, cursor);
    rec.writeUInt32LE(length, cursor + 4);
    rec.writeUInt8(1, cursor + 8);
    rec.writeUInt8(name.length / 2, cursor + 9);
    rec.writeUInt16LE(0x40, cursor + 0x0a);
    rec.writeBigUInt64LE(BigInt(options.wof.allocated), cursor + 0x28);
    rec.writeBigUInt64LE(BigInt(options.wof.size), cursor + 0x30);
    name.copy(rec, cursor + 0x40);
    cursor += length;
  }
  rec.writeUInt32LE(0xffffffff, cursor);
  return rec;
}
