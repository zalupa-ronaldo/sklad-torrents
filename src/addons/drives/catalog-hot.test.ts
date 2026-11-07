import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLogicalSize } from "@/addons/drives/file-size";
import { indexFetchPlan } from "@/addons/drives/shelf-plan";
import { detachUnreachableHosts, mergeVolumeRecords } from "@/addons/drives/reconcile";
import { clearStages, recentStages } from "@/addons/drives/stage";
import {
  attachShardStats,
  clearLiveDisks,
  persistLargeCatalog,
  persistLargeCatalogUnlocked,
  readCatalog,
  shardIsCurrent,
} from "@/addons/drives/store";
import type { DiskRecord, IndexedFile } from "@/addons/drives/types";

let directory = "";
let previous: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sklad-hot-"));
  previous = process.env.SKLAD_DATA_DIR;
  process.env.SKLAD_DATA_DIR = directory;
  clearLiveDisks();
  clearStages();
});

afterEach(async () => {
  if (previous === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previous;
  clearLiveDisks();
  await rm(directory, { recursive: true, force: true });
});

function files(count: number, size: number | null): IndexedFile[] {
  return Array.from({ length: count }, (_, index) => ({
    relativePath: `vault/f${index}.zip`,
    name: `f${index}.zip`,
    kind: "file" as const,
    size,
    mtimeMs: 1,
    sidecarCategory: null,
    categories: [],
  }));
}

function record(partial: Partial<DiskRecord> & Pick<DiskRecord, "id" | "volumeUuid">): DiskRecord {
  const uuidNorm = partial.volumeUuid.replace(/-/g, "").toLowerCase();
  return {
    serial: partial.serial ?? "SERIAL",
    serialNorm: (partial.serial ?? "SERIAL").toUpperCase(),
    filesystem: "APFS",
    label: partial.label ?? "vault",
    namedByUser: false,
    volumeName: partial.volumeName ?? partial.label ?? "vault",
    totalBytes: 1_000_000_000_000,
    freeBytes: 100_000_000_000,
    lastSeenAt: "2026-11-07T00:00:00.000Z",
    lastHostId: "mac-mini",
    lastHostName: "Mac mini",
    pathStyle: "posix",
    lastMountPath: "/Volumes/vault",
    priorMountPath: "",
    connectedHosts: [{ id: "mac-mini", name: "Mac mini", os: "darwin", elevated: false, mountPaths: ["/Volumes/vault"] }],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: { status: "complete", strategy: "walk", progress: 1, message: "ok", elevated: false },
    files: [],
    ...partial,
    uuidNorm,
  };
}

describe("catalog hot path", () => {
  it("lets two shard writers finish and does not rewrite an unchanged snapshot", async () => {
    const disk = record({
      id: "disk-2fe6776e-1111-4111-8111-111111111111",
      volumeUuid: "54C64F37-629A-410E-B506-92969EF32EEC",
      indexRevision: "snap-vault",
      files: files(20_001, 4096),
    });
    await Promise.all([
      persistLargeCatalogUnlocked([disk]),
      persistLargeCatalogUnlocked([disk]),
    ]);
    const shard = path.join(directory, "drive-files", `${disk.id}.ndjson`);
    const first = await stat(shard);
    expect(first.size).toBeGreaterThan(100_000);
    const temps = (await readdir(path.join(directory, "drive-files"))).filter((name) => name.includes(".tmp"));
    expect(temps).toEqual([]);
    clearStages();
    await persistLargeCatalog([disk]);
    const second = await stat(shard);
    expect(second.mtimeMs).toBe(first.mtimeMs);
    expect(recentStages().some((sample) => sample.stage === "shard-write")).toBe(false);
    expect(recentStages().some((sample) => sample.stage === "shard-skip")).toBe(true);
    const saved = await readCatalog();
    expect(saved?.disks[0]?.fileStore).toBe(shard);
    expect(saved?.disks[0]?.shardRevision).toBe("snap-vault");
    expect(saved?.disks[0]?.files).toEqual([]);
  });

  it("keeps the shard id when a legacy record and a new id share a volume", () => {
    const legacy = record({
      id: "disk-2fe6776e-1111-4111-8111-111111111111",
      volumeUuid: "54C64F37-629A-410E-B506-92969EF32EEC",
      fileStore: "/data/drive-files/disk-2fe6776e-1111-4111-8111-111111111111.ndjson",
      shardBytes: 162_457_697,
      shardRevision: "snap-vault",
      summary: { fileCount: 519_591, indexedBytes: 10, categoryCounts: { torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 } },
    });
    const fresh = record({
      id: "disk-aaaaaaaaaaaaaaaaaaaa",
      volumeUuid: "54c64f37-629a-410e-b506-92969ef32eec",
      serial: "",
      files: [],
      summary: { fileCount: 0, indexedBytes: 0, categoryCounts: legacy.summary!.categoryCounts },
    });
    fresh.serialNorm = "";
    const [kept] = mergeVolumeRecords([fresh, legacy]);
    expect(kept?.id).toBe(legacy.id);
    expect(kept?.fileStore).toBe(legacy.fileStore);
    expect(kept?.shardBytes).toBe(162_457_697);
  });

  it("does not download a snapshot that is already stored, and does not treat a missing size as zero", async () => {
    const disk = record({
      id: "disk-vault",
      volumeUuid: "54C64F37-629A-410E-B506-92969EF32EEC",
      indexRevision: "snap-vault",
      files: [],
    });
    disk.fileStore = path.join(directory, "drive-files", "disk-vault.ndjson");
    await persistLargeCatalog([{ ...disk, files: files(20_001, null) }]);
    await attachShardStats([disk]);
    expect(shardIsCurrent(disk)).toBe(true);
    expect(indexFetchPlan({
      state: "complete",
      revision: "snap-vault",
      recordCount: 519_591,
      knownRevision: disk.indexRevision,
      localRecords: disk.shardBytes && disk.shardBytes > 0 ? 519_591 : 0,
    })).toBe("skip");
    expect(indexFetchPlan({
      state: "complete",
      revision: "snap-data",
      recordCount: 1_540_488,
      knownRevision: "snap-data",
      localRecords: 0,
    })).toBe("defer");
    expect(indexFetchPlan({ state: "complete", revision: "z", recordCount: 0 })).toBe("none");
    expect(readLogicalSize({})).toBeNull();
    expect(readLogicalSize({ size: 0 })).toBe(0);
    expect(readLogicalSize({ logicalSize: "4096" })).toBe(4096);
  });

  it("drops a silent windows agent without clearing the cached sizes", () => {
    const disk = record({
      id: "disk-c",
      volumeUuid: "11111111-1111-4111-8111-111111111111",
      serial: "C-SERIAL",
      label: "C",
      filesystem: "NTFS",
      pathStyle: "win32",
      lastMountPath: "C:\\",
      files: files(2, 100),
      summary: { fileCount: 2, indexedBytes: 200, categoryCounts: { torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 } },
    });
    disk.connectedHosts = [{ id: "windows-pc", name: "Windows PC", os: "win32", elevated: true, mountPaths: ["C:\\"] }];
    const [offline] = detachUnreachableHosts(
      [disk],
      [{ id: "windows-pc", name: "Windows PC", os: "win32" }],
      [{ id: "windows-pc", os: "win32" }],
    );
    expect(offline?.connectedHosts).toEqual([]);
    expect(offline?.files).toHaveLength(2);
    expect(offline?.files[0]?.size).toBe(100);
    expect(offline?.summary?.indexedBytes).toBe(200);
  });
});
