import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { classifyFilesYielding } from "@/addons/drives/categories";
import { emptyCategoryCounts } from "@/addons/drives/disk-summary";
import { normalizeSerial, normalizeUuid } from "@/addons/drives/identity";
import { describeScan } from "@/addons/drives/strategy";
import { recordStage } from "@/addons/drives/stage";
import type { DeferredSnapshot } from "@/addons/drives/agent-client";
import type { DiskRecord, IngestProgress, LibraryRule, RawIndexedFile } from "@/addons/drives/types";
import { liveDisks, persistLargeCatalogUnlocked, setLiveDisks, shardIsCurrent, withCatalogWrite } from "@/addons/drives/store";
import { dataDir } from "@/lib/qbittorrent/store";

const running = new Set<string>();
const failedAt = new Map<string, number>();
let retryMs = 30_000;
let tail: Promise<void> = Promise.resolve();

const PAGE = 10_000;

export function setIngestRetryMsForTests(ms: number): void {
  retryMs = ms;
}

export function ingestIsActive(volumeUuid: string, revision: string): boolean {
  return running.has(keyOf(volumeUuid, revision));
}

function keyOf(volumeUuid: string, revision: string): string {
  return `${normalizeUuid(volumeUuid)}:${revision}`;
}

export function scheduleIndexIngest(jobs: readonly DeferredSnapshot[], libraries: readonly LibraryRule[]): void {
  for (const job of jobs) {
    const key = keyOf(job.volumeUuid, job.revision);
    if (!key || key.startsWith(":") || running.has(key)) continue;
    const failed = failedAt.get(key) ?? 0;
    if (Date.now() - failed < retryMs) continue;
    const existing = findLive(job.serial, job.volumeUuid);
    if (existing && coversSnapshot(existing, job.revision)) continue;
    running.add(key);
    note(job, { phase: "queued", pages: 0, records: 0, expected: job.recordCount });
    const run = tail.then(() => ingest(job, libraries), () => ingest(job, libraries));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    void run.then(
      () => {
        failedAt.delete(key);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "ingest failed";
        failedAt.set(key, Date.now());
        const disk = findLive(job.serial, job.volumeUuid);
        note(job, {
          phase: "failed",
          pages: disk?.ingest?.pages ?? 0,
          records: disk?.ingest?.records ?? 0,
          expected: job.recordCount,
          error: message.slice(0, 120),
        });
        if (disk?.pendingRevision === job.revision && !coversSnapshot(disk, job.revision)) disk.pendingRevision = undefined;
      },
    ).finally(() => running.delete(key));
  }
}

function coversSnapshot(disk: DiskRecord, revision: string): boolean {
  if (disk.indexRevision !== revision && disk.shardRevision !== revision) return false;
  return disk.files.length > 0 || shardIsCurrent(disk);
}

async function ingest(job: DeferredSnapshot, libraries: readonly LibraryRule[]): Promise<void> {
  const already = findLive(job.serial, job.volumeUuid);
  if (already && coversSnapshot(already, job.revision)) return;
  const diskId = already?.id;
  if (!diskId) throw new Error("disk missing");
  const dir = path.join(dataDir(), "drive-files");
  await mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, `${diskId.replace(/[^a-zA-Z0-9._-]/g, "")}.ndjson`);
  const temp = `${finalPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const stream = createWriteStream(temp);
  const summary = { fileCount: 0, indexedBytes: 0, categoryCounts: emptyCategoryCounts(), unknownSizes: 0 };
  let records = 0;
  let pages = 0;
  const base = job.agent.url.replace(/\/$/, "");
  try {
    while (records < job.recordCount) {
      const params = new URLSearchParams({
        serial: job.serial,
        uuid: job.volumeUuid,
        revision: job.revision,
        offset: String(records),
        limit: String(PAGE),
      });
      const response = await fetch(`${base}/v1/files?${params}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`http ${response.status}`);
      const page = (await response.json()) as { files?: RawIndexedFile[]; revision?: string; total?: number };
      if (page.revision !== job.revision || !Array.isArray(page.files) || page.files.length === 0) {
        throw new Error(`page short ${records}/${job.recordCount}`);
      }
      const files = await classifyFilesYielding(page.files, libraries, already?.pathStyle ?? "posix", already?.lastMountPath ?? "");
      for (const file of files) {
        if (file.kind !== "file" || file.name === "sklad-catalog.json") continue;
        summary.fileCount += 1;
        if (file.size == null) summary.unknownSizes += 1;
        else if (file.size > 0) summary.indexedBytes += file.size;
        for (const category of file.categories) if (summary.categoryCounts[category] != null) summary.categoryCounts[category] += 1;
        if (!stream.write(`${JSON.stringify(file)}\n`)) {
          await new Promise<void>((resolve) => stream.once("drain", () => resolve()));
        }
      }
      records += page.files.length;
      pages += 1;
      note(job, { phase: "page", pages, records, expected: job.recordCount });
      if (records > job.recordCount) throw new Error(`page overshot ${records}/${job.recordCount}`);
    }
    if (records !== job.recordCount) throw new Error(`page short ${records}/${job.recordCount}`);
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.end(() => resolve());
    });
  } catch (error) {
    stream.destroy();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  note(job, { phase: "write", pages, records, expected: job.recordCount });
  await rename(temp, finalPath);
  const bytes = (await stat(finalPath)).size;
  await withCatalogWrite(async () => {
    const disk = findLive(job.serial, job.volumeUuid);
    if (!disk) throw new Error("disk missing");
    if (coversSnapshot(disk, job.revision)) return;
    disk.files = [];
    disk.summary = summary.unknownSizes > 0 ? summary : { fileCount: summary.fileCount, indexedBytes: summary.indexedBytes, categoryCounts: summary.categoryCounts };
    disk.indexRevision = job.revision;
    disk.fileStore = finalPath;
    disk.shardBytes = bytes;
    disk.shardRevision = job.revision;
    disk.pendingRevision = undefined;
    disk.reportedRecords = records;
    disk.ingest = { phase: "done", pages, records, expected: job.recordCount };
    const described = describeScan({
      filesystem: disk.filesystem,
      platform: disk.pathStyle === "win32" ? "win32" : "darwin",
      elevated: disk.scan.elevated,
      status: "complete",
      busy: false,
    });
    disk.scan = { status: "complete", strategy: described.strategy, progress: 1, message: described.message, elevated: disk.scan.elevated };
    const live = liveDisks() ?? [];
    if (!live.includes(disk)) setLiveFrom(live, disk);
    await persistLargeCatalogUnlocked(liveDisks() ?? [disk]);
  });
  recordStage("ingest-done", 0, records);
}

function note(job: DeferredSnapshot, patch: IngestProgress): void {
  const disk = findLive(job.serial, job.volumeUuid);
  if (disk) {
    disk.ingest = patch;
    disk.pendingRevision = patch.phase === "done" || patch.phase === "failed" ? undefined : job.revision;
    disk.reportedRecords = job.recordCount;
  }
  recordStage(`ingest-${patch.phase}`, 0, patch.records);
}

function setLiveFrom(live: DiskRecord[], disk: DiskRecord): void {
  const next = live.map((item) => (item.uuidNorm && item.uuidNorm === disk.uuidNorm ? disk : item));
  if (!next.includes(disk)) next.push(disk);
  setLiveDisks(next);
}

function findLive(serial: string, volumeUuid: string): DiskRecord | undefined {
  const serialNorm = normalizeSerial(serial);
  const uuidNorm = normalizeUuid(volumeUuid);
  return liveDisks()?.find((disk) => disk.uuidNorm === uuidNorm && (!serialNorm || disk.serialNorm === serialNorm));
}
