import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { toIndexedFiles } from "@/addons/drives/categories";
import { summarizeIndexed } from "@/addons/drives/disk-summary";
import { normalizeSerial, normalizeUuid, stableDiskId } from "@/addons/drives/identity";
import { readCatalog, writeCatalog } from "@/addons/drives/store";
import type { DiskRecord, IndexedFile, RawIndexedFile } from "@/addons/drives/types";
import { createJobStore, type JobStore } from "@/lib/jobs/engine";
import type { Job } from "@/lib/jobs/model";
import { dataDir } from "@/lib/qbittorrent/store";

export interface SnapshotFixture {
  format: "sklad-snapshot-v1";
  serial: string;
  volumeUuid: string;
  label: string;
  letter?: string;
  files: RawIndexedFile[];
}

export function snapshotDigest(files: readonly { relativePath: string; kind?: string; size: number | null }[]): string {
  const lines = files
    .map((file) => `${file.kind === "dir" ? "dir" : "file"}\t${file.relativePath}\t${file.size ?? ""}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function parseSnapshotFixture(payload: unknown): SnapshotFixture {
  if (!payload || typeof payload !== "object") throw new Error("Снимок не является объектом JSON.");
  const raw = payload as Partial<SnapshotFixture>;
  if (raw.format !== "sklad-snapshot-v1") {
    throw new Error("Импорт WizTree MFT не подключён. Нужен формат sklad-snapshot-v1.");
  }
  if (!raw.serial?.trim() || !raw.volumeUuid?.trim() || !raw.label?.trim() || !Array.isArray(raw.files) || raw.files.length === 0) {
    throw new Error("В снимке нужны serial, volumeUuid, label и непустой список files.");
  }
  const letter = String(raw.letter ?? "").replace(":", "").toUpperCase();
  if (letter === "E" || letter === "Z") throw new Error("Тома E и Z в офлайн-снимок не принимаются.");
  return {
    format: "sklad-snapshot-v1",
    serial: raw.serial.trim(),
    volumeUuid: raw.volumeUuid.trim(),
    label: raw.label.trim().slice(0, 80),
    ...(letter ? { letter } : {}),
    files: raw.files.map((file) => ({
      relativePath: String(file.relativePath || ""),
      name: String(file.name || ""),
      kind: file.kind === "dir" ? "dir" : "file",
      size: file.size === null ? null : Number(file.size),
      mtimeMs: Number(file.mtimeMs) || 0,
    })),
  };
}

export async function ingestSnapshot(fixture: SnapshotFixture, directory = dataDir()): Promise<{
  diskId: string;
  files: number;
  digest: string;
  jobId: string;
  jobCreated: boolean;
  jobState: string;
}> {
  const files = toIndexedFiles(fixture.files, [], "win32", fixture.letter ? `${fixture.letter}:\\` : "");
  if (files.length === 0) throw new Error("После разбора в снимке не осталось файлов.");
  const digest = snapshotDigest(files);
  const id = stableDiskId(fixture.serial, fixture.volumeUuid);
  const now = new Date().toISOString();
  const disk = snapshotDisk(id, fixture, files, digest, now);
  const existing = await readCatalog();
  const disks = existing?.disks.filter((item) => item.id !== id) ?? [];
  const previous = existing?.disks.find((item) => item.id === id);
  if (previous?.namedByUser) {
    disk.label = previous.label;
    disk.namedByUser = true;
  }
  await writeCatalog({ version: 2, seeded: true, disks: [...disks, disk] });
  await writeLibrary(directory, {
    diskId: id,
    title: null,
    confidence: "none",
    provenance: "sklad-snapshot-v1",
    fileCount: disk.summary?.fileCount ?? 0,
    indexedBytes: disk.summary?.indexedBytes ?? 0,
  });
  const store = createJobStore(directory);
  const queued = await store.enqueue(
    {
      kind: "index",
      host: "mac-local",
      source: `snapshot:${id}:${digest}`,
      destination: `receipt:${id}`,
      diskId: id,
    },
    { anyState: true },
  );
  return {
    diskId: id,
    files: disk.summary?.fileCount ?? files.length,
    digest,
    jobId: queued.job.id,
    jobCreated: queued.created,
    jobState: queued.job.state,
  };
}

export async function verifySnapshotJob(store: JobStore, directory = dataDir()): Promise<{ processed: boolean; jobId?: string; state?: string; verified?: boolean; error?: string }> {
  await store.adoptOrphans("mac-local");
  if (process.env.SKLAD_CRASH_AFTER_CLAIM === "1") {
    const crashed = await store.claimNext("mac-local", (job) => job.kind === "index" && job.payload.source.startsWith("snapshot:"));
    if (crashed?.workerToken) process.exit(86);
  }
  const job = await store.claimNext("mac-local", (item) => item.kind === "index" && item.payload.source.startsWith("snapshot:"));
  if (!job?.workerToken) return { processed: false };
  const token = job.workerToken;
  try {
    const checked = await checkSnapshot(job, directory);
    if (!checked.ok) {
      await store.fail(job.id, token, checked.reason);
      return { processed: true, jobId: job.id, state: "error", verified: false, error: checked.reason };
    }
    await mkdir(path.join(directory, "receipts"), { recursive: true });
    const receipt = path.join(directory, "receipts", `${job.payload.diskId}.json`);
    await writeFile(receipt, JSON.stringify({ diskId: job.payload.diskId, digest: checked.digest, files: checked.files, verified: true }), "utf8");
    const done = await store.complete(job.id, token);
    return { processed: true, jobId: job.id, state: done?.state ?? "done", verified: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Проверка снимка не выполнилась.";
    await store.fail(job.id, token, message);
    return { processed: true, jobId: job.id, state: "error", verified: false, error: message };
  }
}

async function checkSnapshot(job: Job, directory: string): Promise<{ ok: true; digest: string; files: number } | { ok: false; reason: string }> {
  const catalog = await readCatalogFile(directory);
  const disk = catalog.find((item) => item.id === job.payload.diskId);
  if (!disk) return { ok: false, reason: "Диск снимка не найден в каталоге." };
  if (disk.files.length === 0) return { ok: false, reason: "Снимок пуст. Проверка не подтверждена." };
  const digest = snapshotDigest(disk.files);
  if (digest !== disk.indexRevision) return { ok: false, reason: "Контрольная сумма снимка не совпала. Результат не подтверждён." };
  return { ok: true, digest, files: disk.files.length };
}

async function readCatalogFile(directory: string): Promise<DiskRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, "drives.json"), "utf8")) as { disks?: DiskRecord[] };
    return Array.isArray(parsed.disks) ? parsed.disks : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeLibrary(directory: string, entry: { diskId: string; title: null; confidence: "none"; provenance: string; fileCount: number; indexedBytes: number }): Promise<void> {
  const file = path.join(directory, "library.json");
  let entries: unknown[] = [];
  let games: unknown[] = [];
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { entries?: unknown[]; games?: unknown[] };
    entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    games = Array.isArray(parsed.games) ? parsed.games : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rest = entries.filter((item) => !item || typeof item !== "object" || (item as { diskId?: string }).diskId !== entry.diskId);
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify({ entries: [...rest, entry], games }, null, 2), "utf8");
}

function snapshotDisk(id: string, fixture: SnapshotFixture, files: IndexedFile[], digest: string, now: string): DiskRecord {
  const summary = summarizeIndexed(files);
  return {
    id,
    serial: fixture.serial,
    serialNorm: normalizeSerial(fixture.serial),
    volumeUuid: fixture.volumeUuid,
    uuidNorm: normalizeUuid(fixture.volumeUuid),
    filesystem: "NTFS",
    label: fixture.label,
    namedByUser: false,
    volumeName: fixture.label,
    totalBytes: 0,
    freeBytes: 0,
    lastSeenAt: now,
    lastHostId: "offline-snapshot",
    lastHostName: "Снимок",
    pathStyle: "win32",
    lastMountPath: fixture.letter ? `${fixture.letter}:\\` : "",
    priorMountPath: "",
    connectedHosts: [],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: {
      status: "complete",
      strategy: "mft-usn",
      progress: 1,
      message: "Офлайн-снимок. Диск не сканировался. WizTree не использовался.",
      elevated: false,
    },
    files,
    summary,
    indexRevision: digest,
    reportedRecords: summary.fileCount,
  };
}
