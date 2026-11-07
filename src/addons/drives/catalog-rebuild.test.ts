import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { uniqueDisks } from "@/addons/drives/disk-table";
import { reconcileCatalog } from "@/addons/drives/reconcile";
import {
  catalogFilePath,
  clearLiveDisks,
  ensureCleanCatalog,
  liveDisks,
  persistLargeCatalog,
  readCatalog,
} from "@/addons/drives/store";
import type { DiskRecord, HostObservation } from "@/addons/drives/types";

const fixtureGz = path.join(process.cwd(), "src/addons/drives/fixtures/catalog.sanitized.json.gz");

let directory = "";
let previousData: string | undefined;
let previousReset: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sklad-rebuild-"));
  previousData = process.env.SKLAD_DATA_DIR;
  previousReset = process.env.SKLAD_CATALOG_RESET;
  process.env.SKLAD_DATA_DIR = directory;
  delete process.env.SKLAD_CATALOG_RESET;
  clearLiveDisks();
});

afterEach(async () => {
  if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previousData;
  if (previousReset === undefined) delete process.env.SKLAD_CATALOG_RESET;
  else process.env.SKLAD_CATALOG_RESET = previousReset;
  clearLiveDisks();
  await rm(directory, { recursive: true, force: true });
});

function mac(id: string, uuid: string, label: string): DiskRecord {
  const uuidNorm = uuid.replace(/-/g, "").toLowerCase();
  return {
    id,
    serial: "",
    serialNorm: "",
    volumeUuid: uuid,
    uuidNorm,
    filesystem: "APFS",
    label,
    namedByUser: label === "Фильмы",
    volumeName: label,
    totalBytes: 1_000_000_000_000,
    freeBytes: 100,
    lastSeenAt: "2026-11-07T00:00:00.000Z",
    lastHostId: "mac-mini",
    lastHostName: "Mac mini",
    pathStyle: "posix",
    lastMountPath: "/Volumes/" + label,
    priorMountPath: "",
    connectedHosts: [{ id: "mac-mini", name: "Mac mini", os: "darwin", elevated: false, mountPaths: ["/Volumes/" + label] }],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: { status: "complete", strategy: "walk", progress: 1, message: "ok", elevated: false },
    files: [],
    summary: label === "vault"
      ? { fileCount: 519591, indexedBytes: 10, categoryCounts: { torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 } }
      : undefined,
    fileStore: label === "vault" ? "/archive/vault.ndjson" : undefined,
    shardBytes: label === "vault" ? 162_457_697 : undefined,
    shardRevision: label === "vault" ? "snap" : undefined,
  };
}

describe("clean catalog identity", () => {
  it("collapses the sanitized 26978-record fixture by disk id and does not grow", async () => {
    const started = performance.now();
    const parsed = JSON.parse(gunzipSync(await readFile(fixtureGz)).toString("utf8")) as { disks: DiskRecord[] };
    const parseMs = performance.now() - started;
    expect(parsed.disks).toHaveLength(26978);
    const once = uniqueDisks(parsed.disks);
    const twice = uniqueDisks(once);
    const ids = new Set(parsed.disks.map((disk) => disk.id));
    expect(once).toHaveLength(ids.size);
    expect(twice).toHaveLength(ids.size);
    expect(once.length).toBeLessThan(100);
    const vault = once.find((disk) => disk.id === "disk-2fe6776e-f185-43f5-b679-bc2016bf4527");
    const data = once.find((disk) => disk.id === "disk-cc0f3fc9-4322-4be5-ac94-aa61be127be0");
    expect(vault).toBeTruthy();
    expect(data).toBeTruthy();
    expect(vault?.volumeUuid).not.toBe(data?.volumeUuid);
    const windows = once.find((disk) => disk.id === "disk-710771d8ad08f56469ed");
    expect(windows?.fileStore).toContain("disk-710771d8ad08f56469ed.ndjson");
    expect(windows?.summary?.fileCount).toBeGreaterThan(0);
    console.info(`fixture-dedupe records=${parsed.disks.length} unique=${once.length} parseMs=${Math.round(parseMs)}`);
  }, 60_000);

  it("does not merge two volumes that only share a name and a capacity", () => {
    const left = mac("disk-data", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Data");
    const right = mac("disk-other", "11111111-2222-4333-8444-555555555555", "Data");
    right.totalBytes = left.totalBytes;
    const kept = uniqueDisks([left, right, left, right]);
    expect(kept.map((disk) => disk.id).sort()).toEqual(["disk-data", "disk-other"]);
  });

  it("keeps one record when the same id is saved repeatedly, including the old triple-concat", async () => {
    const vault = mac("disk-f479b535-68ed-4dc3-a6ce-c84ca4dcef74", "54C64F37-629A-410E-B506-92969EF32EEC", "vault");
    const data = mac("disk-cc0f3fc9-4322-4be5-ac94-aa61be127be0", "F21D84D5-4718-4971-A377-D9ECBA00E401", "Data");
    const bloated = Array.from({ length: 27 }, () => [vault, data]).flat();
    const { setLiveDisks } = await import("@/addons/drives/store");
    setLiveDisks(bloated);
    expect(liveDisks()).toHaveLength(2);
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await persistLargeCatalog(liveDisks() ?? []);
      expect(liveDisks()).toHaveLength(2);
    }
    const saved = await readCatalog();
    expect(saved?.disks).toHaveLength(2);
    expect(saved?.disks.find((disk) => disk.id === vault.id)?.fileStore).toBe("/archive/vault.ndjson");
    expect(saved?.disks.find((disk) => disk.id === vault.id)?.summary?.fileCount).toBe(519591);
    const observation: HostObservation = {
      hostId: "mac-mini",
      hostName: "Mac mini",
      os: "darwin",
      elevated: false,
      volumes: [
        {
          serial: "",
          volumeUuid: vault.volumeUuid,
          filesystem: "APFS",
          volumeName: "vault",
          mountPaths: ["/Volumes/vault"],
          totalBytes: vault.totalBytes,
          freeBytes: 1,
          busy: false,
          index: { state: "complete", progress: 1, revision: "snap-vault", recordCount: 519591 },
        },
        {
          serial: "",
          volumeUuid: data.volumeUuid,
          filesystem: "APFS",
          volumeName: "Data",
          mountPaths: ["/Volumes/Data"],
          totalBytes: data.totalBytes,
          freeBytes: 1,
          busy: false,
          index: { state: "complete", progress: 1, revision: "snap-data", recordCount: 1540488 },
        },
      ],
    };
    let current = saved?.disks ?? [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      current = reconcileCatalog(current, [observation, observation, observation], [], new Date().toISOString());
      expect(current).toHaveLength(2);
      expect(new Set(current.map((disk) => disk.id)).size).toBe(2);
    }
    expect(current.find((disk) => disk.id === vault.id)?.summary?.fileCount).toBe(519591);
    expect(current.find((disk) => disk.id === data.id)?.reportedRecords).toBe(1540488);
    expect(current.find((disk) => disk.id === data.id)?.summary).toBeUndefined();
    expect(current.find((disk) => disk.id === data.id)?.pendingRevision).toBe("snap-data");
    expect(current.find((disk) => disk.id === data.id)?.indexRevision).toBeUndefined();
  });

  it("archives the old catalog on reset and does not parse it into the live shelf", async () => {
    await mkdir(directory, { recursive: true });
    const bloated = {
      version: 2,
      seeded: true,
      disks: Array.from({ length: 9 }, () => mac("disk-f479b535-68ed-4dc3-a6ce-c84ca4dcef74", "54C64F37-629A-410E-B506-92969EF32EEC", "vault")),
    };
    await writeFile(path.join(directory, "drives.json"), JSON.stringify(bloated));
    await writeFile(path.join(directory, "drives.json.premigrate"), "{\"version\":1,\"seeded\":true,\"disks\":[]}");
    process.env.SKLAD_CATALOG_RESET = "1";
    const first = await readCatalog();
    expect(first).toBeNull();
    expect(liveDisks()).toBeNull();
    const archives = await readdir(path.join(directory, "archive"));
    expect(archives.length).toBe(1);
    const archived = JSON.parse(await readFile(path.join(directory, "archive", archives[0]!, "drives.json"), "utf8")) as { disks: DiskRecord[] };
    expect(archived.disks).toHaveLength(9);
    await stat(path.join(directory, "archive", archives[0]!, "drives.json.premigrate"));
    await expect(stat(catalogFilePath())).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(catalogFilePath(), JSON.stringify({ version: 2, seeded: true, disks: [mac("disk-new", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "vault")] }));
    const second = await readCatalog();
    expect(second?.disks).toHaveLength(1);
    expect(second?.disks[0]?.id).toBe("disk-new");
    const still = await readdir(path.join(directory, "archive"));
    expect(still).toEqual(archives);
  });
});
