import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scheduleIndexIngest, setIngestRetryMsForTests } from "@/addons/drives/shelf-ingest";
import { clearLiveDisks, liveDisks, setLiveDisks } from "@/addons/drives/store";
import { browseRoots } from "@/addons/drives/browse";
import type { DiskRecord } from "@/addons/drives/types";

const VAULT_COUNT = 519_591;
const DATA_COUNT = 1_540_488;
const VAULT_UUID = "54C64F37-629A-410E-B506-92969EF32EEC";
const DATA_UUID = "F21D84D5-4718-4971-A377-D9ECBA00E401";

let directory = "";
let previousData: string | undefined;
let server: Server | undefined;
let dataFailures = 0;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sklad-import-"));
  previousData = process.env.SKLAD_DATA_DIR;
  process.env.SKLAD_DATA_DIR = directory;
  clearLiveDisks();
  setIngestRetryMsForTests(0);
  dataFailures = 0;
});

afterEach(async () => {
  if (previousData === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previousData;
  setIngestRetryMsForTests(30_000);
  clearLiveDisks();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

function norm(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

function disk(id: string, uuid: string, label: string, mount: string): DiskRecord {
  return {
    id,
    serial: "",
    serialNorm: "",
    volumeUuid: uuid,
    uuidNorm: norm(uuid),
    filesystem: "APFS",
    label,
    namedByUser: false,
    volumeName: label,
    totalBytes: 1_000_000_000_000,
    freeBytes: 10,
    lastSeenAt: "2026-11-07T00:00:00.000Z",
    lastHostId: "mac-mini",
    lastHostName: "Mac mini",
    pathStyle: "posix",
    lastMountPath: mount,
    priorMountPath: "",
    connectedHosts: [{ id: "mac-mini", name: "Mac mini", os: "darwin", elevated: false, mountPaths: [mount] }],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: { status: "idle", strategy: "walk", progress: 0, message: "ждём снимок", elevated: false },
    files: [],
    reportedRecords: label === "Data" ? DATA_COUNT : VAULT_COUNT,
    pendingRevision: label === "Data" ? "snap-data" : "snap-vault",
  };
}

async function listen(): Promise<string> {
  server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const uuid = url.searchParams.get("uuid") || "";
    const total = norm(uuid) === norm(DATA_UUID) ? DATA_COUNT : VAULT_COUNT;
    const revision = norm(uuid) === norm(DATA_UUID) ? "snap-data" : "snap-vault";
    if (norm(uuid) === norm(DATA_UUID) && dataFailures > 0) {
      dataFailures -= 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "busy" }));
      return;
    }
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.min(10_000, Math.max(1, Number(url.searchParams.get("limit")) || 10_000));
    const end = Math.min(total, offset + limit);
    const files = [];
    for (let index = offset; index < end; index += 1) {
      files.push({
        relativePath: `v/f${index}.bin`,
        name: `f${index}.bin`,
        kind: "file",
        size: 100,
        mtimeMs: 1,
      });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ revision, total, files }));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("snapshot import of two large volumes", () => {
  it("imports vault and Data from existing pages, retries Data, and keeps the root pending until the shard exists", async () => {
    dataFailures = 1;
    const url = await listen();
    const vault = disk("disk-vault", VAULT_UUID, "vault", "/Volumes/vault");
    const data = disk("disk-data", DATA_UUID, "Data", "/System/Volumes/Data");
    setLiveDisks([vault, data]);
    const before = browseRoots(liveDisks() ?? []).entries.find((entry) => entry.diskId === "disk-data");
    expect(before?.sizesReady).toBe(false);
    expect(before?.size).toBeNull();
    const agent = { id: "mac-mini", name: "Mac mini", os: "darwin" as const, url };
    scheduleIndexIngest([
      { agent, serial: "", volumeUuid: VAULT_UUID, revision: "snap-vault", recordCount: VAULT_COUNT },
      { agent, serial: "", volumeUuid: DATA_UUID, revision: "snap-data", recordCount: DATA_COUNT },
    ], []);
    const deadline = Date.now() + 180_000;
    let sawProgress = false;
    let sawFailure = false;
    while (Date.now() < deadline) {
      const rows = liveDisks() ?? [];
      const dataRow = rows.find((item) => item.id === "disk-data");
      if ((dataRow?.ingest?.records ?? 0) > 0 && (dataRow?.ingest?.records ?? 0) < DATA_COUNT) sawProgress = true;
      if (dataRow?.ingest?.phase === "failed" || dataRow?.ingest?.error) sawFailure = true;
      if (rows.length === 2 && rows.every((item) => item.ingest?.phase === "done" && item.shardRevision)) break;
      scheduleIndexIngest([
        { agent, serial: "", volumeUuid: VAULT_UUID, revision: "snap-vault", recordCount: VAULT_COUNT },
        { agent, serial: "", volumeUuid: DATA_UUID, revision: "snap-data", recordCount: DATA_COUNT },
      ], []);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const done = liveDisks() ?? [];
    expect(done).toHaveLength(2);
    expect(new Set(done.map((item) => item.id)).size).toBe(2);
    const dataDone = done.find((item) => item.id === "disk-data");
    const vaultDone = done.find((item) => item.id === "disk-vault");
    expect(dataDone?.ingest).toMatchObject({ phase: "done", records: DATA_COUNT, expected: DATA_COUNT });
    expect(vaultDone?.ingest).toMatchObject({ phase: "done", records: VAULT_COUNT });
    expect(dataDone?.summary?.fileCount).toBe(DATA_COUNT);
    expect(dataDone?.summary?.indexedBytes).toBe(DATA_COUNT * 100);
    expect(dataDone?.shardBytes ?? 0).toBeGreaterThan(1_000_000);
    const root = browseRoots(done).entries.find((entry) => entry.diskId === "disk-data");
    expect(root?.sizesReady).toBe(true);
    expect(root?.size).toBe(DATA_COUNT * 100);
    expect(sawProgress).toBe(true);
    expect(sawFailure).toBe(true);
    const stamp = (await stat(dataDone?.fileStore || "")).mtimeMs;
    scheduleIndexIngest([
      { agent, serial: "", volumeUuid: DATA_UUID, revision: "snap-data", recordCount: DATA_COUNT },
    ], []);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await stat(dataDone?.fileStore || "")).mtimeMs).toBe(stamp);
  }, 180_000);
});
