import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { browseRoots, buildDiskTree } from "@/addons/drives/browse";
import { classifyFilesYielding } from "@/addons/drives/categories";
import { summarizeIndexed } from "@/addons/drives/disk-summary";
import { searchDisks } from "@/addons/drives/search";
import { ingestFailureIsTransient, scheduleIndexIngest, setIngestRetryMsForTests } from "@/addons/drives/shelf-ingest";
import { clearLiveDisks, liveDisks, setLiveDisks } from "@/addons/drives/store";
import type { DiskRecord, IndexedFile, RawIndexedFile } from "@/addons/drives/types";

const KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

function raw(relativePath: string): RawIndexedFile {
  const name = relativePath.split("/").pop() || relativePath;
  return { relativePath, name, kind: "file", size: 12, mtimeMs: 1 };
}

describe("prototype keys in file names", () => {
  it("classifies, summarizes, searches, and folds names that match Object.prototype", async () => {
    const plain: Record<string, string[]> = { mkv: ["media"] };
    const ext = "constructor";
    let thrown = "";
    try {
      for (const item of (plain[ext] ?? [])) item;
    } catch (error) {
      thrown = error instanceof Error ? `${error.name}: ${error.message}` : "";
    }
    expect(thrown).toContain("is not iterable");
    expect(thrown).toContain("Symbol.iterator");

    const files = KEYS.flatMap((key) => [raw(`pkg/readme.${key}`), raw(`${key}/note.txt`)]);
    const indexed = await classifyFilesYielding(files, [], "posix", "/Volumes/Data");
    expect(indexed).toHaveLength(files.length);
    expect(indexed.find((file) => file.name === "readme.constructor")?.categories).toEqual([]);
    const summary = summarizeIndexed(indexed);
    expect(summary.fileCount).toBe(files.length);
    expect(summary.indexedBytes).toBe(files.length * 12);
    const tree = buildDiskTree({
      id: "disk-data",
      serial: "",
      serialNorm: "",
      volumeUuid: "uuid",
      uuidNorm: "uuid",
      filesystem: "APFS",
      label: "Data",
      namedByUser: false,
      volumeName: "Data",
      totalBytes: 1,
      freeBytes: 1,
      lastSeenAt: "",
      lastHostId: "mac",
      lastHostName: "Mac",
      pathStyle: "posix",
      lastMountPath: "/Volumes/Data",
      priorMountPath: "",
      connectedHosts: [],
      duplicateMounts: false,
      possibleClone: false,
      cloneOfIds: [],
      scan: { status: "complete", strategy: "walk", progress: 1, message: "", elevated: false },
      files: indexed,
    });
    expect(tree.root.dirs.get("constructor")?.fileCount).toBe(1);
    expect(tree.root.size).toBe(files.length * 12);
    const searchable = {
      id: "disk-data",
      serial: "",
      serialNorm: "",
      volumeUuid: "uuid",
      uuidNorm: "uuid",
      filesystem: "APFS",
      label: "Data",
      namedByUser: false,
      volumeName: "Data",
      totalBytes: 1,
      freeBytes: 1,
      lastSeenAt: "",
      lastHostId: "mac",
      lastHostName: "Mac",
      pathStyle: "posix" as const,
      lastMountPath: "/Volumes/Data",
      priorMountPath: "",
      connectedHosts: [],
      duplicateMounts: false,
      possibleClone: false,
      cloneOfIds: [],
      scan: { status: "complete" as const, strategy: "walk" as const, progress: 1, message: "", elevated: false },
      files: indexed,
    };
    expect(searchDisks([searchable], "constructor").length).toBeGreaterThan(0);
  });
});

describe("deterministic ingest errors", () => {
  let directory = "";
  let previousData: string | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
    else process.env.SKLAD_DATA_DIR = previousData;
    setIngestRetryMsForTests(30_000);
    clearLiveDisks();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("does not redownload a volume after a data error, and still finishes the other volume", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "sklad-proto-"));
    previousData = process.env.SKLAD_DATA_DIR;
    process.env.SKLAD_DATA_DIR = directory;
    setIngestRetryMsForTests(0);
    let dataHits = 0;
    let vaultHits = 0;
    server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const data = (url.searchParams.get("uuid") || "").toLowerCase().startsWith("aaaaaaaa");
      if (data) dataHits += 1;
      else vaultHits += 1;
      if (data) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        revision: "snap-vault",
        total: 1,
        files: [{ relativePath: "pkg/readme.constructor", name: "readme.constructor", kind: "file", size: 4, mtimeMs: 1 }],
      }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${address.port}`;
    const base = {
      serial: "",
      serialNorm: "",
      filesystem: "APFS",
      namedByUser: false,
      totalBytes: 1_000_000_000_000,
      freeBytes: 1,
      lastSeenAt: "",
      lastHostId: "mac-mini",
      lastHostName: "Mac",
      pathStyle: "posix" as const,
      priorMountPath: "",
      duplicateMounts: false,
      possibleClone: false,
      cloneOfIds: [],
      scan: { status: "idle" as const, strategy: "walk" as const, progress: 0, message: "", elevated: false },
      files: [] as IndexedFile[],
    };
    setLiveDisks([
      { ...base, id: "disk-data", volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", uuidNorm: "aaaaaaaabbbb4ccc8dddeeeeeeeeeeee", label: "Data", volumeName: "Data", lastMountPath: "/System/Volumes/Data", connectedHosts: [{ id: "mac-mini", name: "Mac", os: "darwin", elevated: false, mountPaths: ["/System/Volumes/Data"] }] },
      { ...base, id: "disk-vault", volumeUuid: "11111111-2222-4333-8444-555555555555", uuidNorm: "11111111222243338444555555555555", label: "vault", volumeName: "vault", lastMountPath: "/Volumes/vault", connectedHosts: [{ id: "mac-mini", name: "Mac", os: "darwin", elevated: false, mountPaths: ["/Volumes/vault"] }] },
    ]);
    const agent = { id: "mac-mini", name: "Mac", os: "darwin" as const, url };
    const jobs = [
      { agent, serial: "", volumeUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", revision: "snap-data", recordCount: 1 },
      { agent, serial: "", volumeUuid: "11111111-2222-4333-8444-555555555555", revision: "snap-vault", recordCount: 1 },
    ];
    scheduleIndexIngest(jobs, []);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = liveDisks() ?? [];
      const data = rows.find((item) => item.id === "disk-data");
      const vault = rows.find((item) => item.id === "disk-vault");
      if (data?.ingest?.phase === "failed" && vault?.ingest?.phase === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const data = liveDisks()?.find((item) => item.id === "disk-data");
    const vault = liveDisks()?.find((item) => item.id === "disk-vault");
    expect(data?.ingest?.phase).toBe("failed");
    expect(data?.ingest?.stack || "").toMatch(/JSON|parse|shelf-ingest/);
    expect(data?.ingest?.offset).toBe(0);
    expect(data?.fileStore).toBeUndefined();
    expect(vault?.ingest?.phase).toBe("done");
    expect(ingestFailureIsTransient(new TypeError("function is not iterable"))).toBe(false);
    expect(ingestFailureIsTransient(new Error("http 503"))).toBe(true);
    const hits = dataHits;
    scheduleIndexIngest(jobs, []);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(dataHits).toBe(hits);
    expect(vaultHits).toBeGreaterThan(0);
    const temps = (await readdir(path.join(directory, "drive-files")).catch(() => [] as string[])).filter((name) => name.endsWith(".tmp"));
    expect(temps).toEqual([]);
    const root = browseRoots(liveDisks() ?? []).entries.find((entry) => entry.diskId === "disk-data");
    expect(root?.sizesReady).toBe(false);
    expect(root?.size).toBeNull();
  });
});
