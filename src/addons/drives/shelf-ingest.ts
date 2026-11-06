import { classifyFilesYielding } from "@/addons/drives/categories";
import { normalizeSerial, normalizeUuid } from "@/addons/drives/identity";
import { describeScan } from "@/addons/drives/strategy";
import type { DeferredSnapshot } from "@/addons/drives/agent-client";
import type { DiskRecord, LibraryRule, RawIndexedFile } from "@/addons/drives/types";
import { summarizeIndexed } from "@/addons/drives/disk-summary";
import { liveDisks, persistLargeCatalog } from "@/addons/drives/store";

const running = new Set<string>();

export function scheduleIndexIngest(jobs: readonly DeferredSnapshot[], libraries: readonly LibraryRule[]): void {
  for (const job of jobs) {
    const key = `${normalizeUuid(job.volumeUuid)}:${job.revision}`;
    if (!key || running.has(key)) continue;
    running.add(key);
    void ingest(job, libraries)
      .catch(() => undefined)
      .finally(() => running.delete(key));
  }
}

async function ingest(job: DeferredSnapshot, libraries: readonly LibraryRule[]): Promise<void> {
  const raw: RawIndexedFile[] = [];
  const base = job.agent.url.replace(/\/$/, "");
  while (raw.length < job.recordCount) {
    const params = new URLSearchParams({
      serial: job.serial,
      uuid: job.volumeUuid,
      revision: job.revision,
      offset: String(raw.length),
      limit: "10000",
    });
    const response = await fetch(`${base}/v1/files?${params}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return;
    const page = (await response.json()) as { files?: RawIndexedFile[]; revision?: string };
    if (page.revision !== job.revision || !Array.isArray(page.files) || page.files.length === 0) return;
    raw.push(...page.files);
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (raw.length !== job.recordCount) return;
  const disk = findLive(job.serial, job.volumeUuid);
  if (!disk || disk.indexRevision === job.revision) return;
  const files = await classifyFilesYielding(raw, libraries, disk.pathStyle, disk.lastMountPath);
  disk.files = files;
  disk.summary = summarizeIndexed(files);
  disk.indexRevision = job.revision;
  disk.pendingRevision = undefined;
  disk.reportedRecords = raw.length;
  const described = describeScan({
    filesystem: disk.filesystem,
    platform: disk.pathStyle === "win32" ? "win32" : "darwin",
    elevated: disk.scan.elevated,
    status: "complete",
    busy: false,
  });
  disk.scan = { status: "complete", strategy: described.strategy, progress: 1, message: described.message, elevated: disk.scan.elevated };
  const live = liveDisks();
  if (live) void persistLargeCatalog(live);
}

function findLive(serial: string, volumeUuid: string): DiskRecord | undefined {
  const serialNorm = normalizeSerial(serial);
  const uuidNorm = normalizeUuid(volumeUuid);
  return liveDisks()?.find((disk) => disk.uuidNorm === uuidNorm && (!serialNorm || disk.serialNorm === serialNorm));
}
