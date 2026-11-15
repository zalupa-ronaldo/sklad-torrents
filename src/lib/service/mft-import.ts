import { open } from "node:fs/promises";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { toIndexedFiles } from "@/addons/drives/categories";
import { summarizeIndexed } from "@/addons/drives/disk-summary";
import { catalogFromParsed, parseRecord, type ParsedName } from "@/addons/drives/ntfs-mft";
import { normalizeSerial, normalizeUuid, stableDiskId } from "@/addons/drives/identity";
import { readCatalog, writeCatalog } from "@/addons/drives/store";
import type { DiskRecord, RawIndexedFile } from "@/addons/drives/types";
import { createJobStore } from "@/lib/jobs/engine";
import { dataDir } from "@/lib/qbittorrent/store";
import { snapshotDigest } from "@/lib/service/snapshot-pipeline";

export const VOLDATA_BYTES = 105;

export interface VolData2 {
  bytesPerSector: number;
  bytesPerCluster: number;
  recordSize: number;
  mftBytes: number;
  letter: string;
}

export interface MftImportProgress {
  phase: "reading" | "writing" | "ready" | "cancelled" | "failed";
  records: number;
  recordTotal: number;
  fileBytes: number;
  letter: string;
  diskId: string | null;
  ready: boolean;
  error: string | null;
}

export function parseVolData2(trailer: Buffer, fileBytes: number): VolData2 {
  if (trailer.length !== VOLDATA_BYTES) throw new Error("Хвост WizTree должен быть 105 байт.");
  if (trailer.subarray(0, 8).toString("latin1") !== "VOLDATA2") throw new Error("Хвост WizTree не VOLDATA2.");
  const bytesPerSector = trailer.readUInt32LE(48);
  const bytesPerCluster = trailer.readUInt32LE(52);
  const recordSize = trailer.readUInt32LE(56);
  const mftBytes = Number(trailer.readBigUInt64LE(64));
  const letter = String.fromCharCode(trailer[104] ?? 0).toUpperCase();
  if (bytesPerSector !== 512 || bytesPerCluster !== 4096 || recordSize !== 1024) {
    throw new Error("Геометрия хвоста WizTree не совпала с разобранными образцами.");
  }
  if (trailer.readUInt32LE(44) !== 0 || trailer.readUInt32LE(60) !== 0 || trailer.readUInt32LE(80) !== 2) {
    throw new Error("Постоянные поля хвоста WizTree не совпали.");
  }
  if (!Number.isSafeInteger(mftBytes) || mftBytes <= 0 || mftBytes % recordSize !== 0) {
    throw new Error("Длина MFT в хвосте не кратна записи.");
  }
  if (fileBytes !== mftBytes + VOLDATA_BYTES) throw new Error("Размер файла не равен MFT из хвоста плюс 105 байт.");
  if (!/^[A-Z]$/.test(letter)) throw new Error("В хвосте нет буквы тома.");
  return { bytesPerSector, bytesPerCluster, recordSize, mftBytes, letter };
}

export async function importMftExport(input: {
  filePath: string;
  serial: string;
  volumeUuid: string;
  directory?: string;
}): Promise<{
  diskId: string;
  letter: string;
  protected: boolean;
  records: number;
  badRecords: number;
  files: number;
  dirs: number;
  nonempty: number;
  explicitZero: number;
  unknownSize: number;
  logicalBytes: number;
  allocatedBytes: number;
  unknownAllocated: number;
  hardlinks: number;
  wof: number;
  unresolved: number;
  cycles: number;
  sequenceMismatch: number;
  unsafe: number;
  meta: number;
  rootFiles: number;
  rootDirs: number;
  rss: number;
  durationMs: number;
  jobCreated: boolean;
}> {
  if (input.directory) process.env.SKLAD_DATA_DIR = input.directory;
  const directory = dataDir();
  const started = Date.now();
  assertExportPath(input.filePath);
  const info = await stat(input.filePath);
  if (!info.isFile()) throw new Error("Нужен обычный файл экспорта, не устройство.");
  if (info.size < VOLDATA_BYTES) throw new Error("Хвост WizTree должен быть 105 байт.");
  const handle = await open(input.filePath, "r");
  let closed = false;
  const closeHandle = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  const trailer = Buffer.alloc(VOLDATA_BYTES);
  await handle.read(trailer, 0, VOLDATA_BYTES, info.size - VOLDATA_BYTES);
  let footer: VolData2;
  try {
    footer = parseVolData2(trailer, info.size);
  } catch (error) {
    await closeHandle();
    throw error;
  }
  if (footer.letter === "E" || footer.letter === "F") {
    await closeHandle();
    throw new Error("Тома E и F в импорт не принимаются.");
  }
  const protectedVolume = footer.letter === "Z";
  const id = stableDiskId(input.serial, input.volumeUuid);
  const recordTotal = footer.mftBytes / footer.recordSize;
  const progress = progressPath(directory);
  const cancel = cancelPath(directory);
  await mkdir(directory, { recursive: true });
  await writeProgress(progress, {
    phase: "reading",
    records: 0,
    recordTotal,
    fileBytes: info.size,
    letter: footer.letter,
    diskId: null,
    ready: false,
    error: null,
  });
  const entries: ParsedName[] = [];
  let badRecords = 0;
  const chunk = Buffer.alloc(footer.recordSize * 64);
  let committed = false;
  const tempShard = path.join(directory, "drive-files", `.${id}.${process.pid}.ndjson.tmp`);
  let finalShard: string | null = null;
  let previousShard: string | null = null;
  try {
    for (let index = 0; index < recordTotal; index += 64) {
      if (await cancelled(cancel)) throw new Error("Импорт отменён.");
      const count = Math.min(64, recordTotal - index);
      const { bytesRead } = await handle.read(chunk, 0, count * footer.recordSize, index * footer.recordSize);
      if (bytesRead !== count * footer.recordSize) throw new Error("Файл экспорта оборвался на записи MFT.");
      for (let row = 0; row < count; row += 1) {
        const record = Buffer.from(chunk.subarray(row * footer.recordSize, (row + 1) * footer.recordSize));
        const signature = record.subarray(0, 4).toString("latin1");
        if (signature !== "FILE") continue;
        if ((record.readUInt16LE(0x16) & 0x01) === 0) continue;
        const parsed = parseRecord(record, index + row, footer.bytesPerSector);
        if (!parsed) badRecords += 1;
        else entries.push(parsed);
      }
      if (index % 256 === 0) {
        await writeProgress(progress, {
          phase: "reading",
          records: index + count,
          recordTotal,
          fileBytes: info.size,
          letter: footer.letter,
          diskId: null,
          ready: false,
          error: null,
        });
      }
    }
    await closeHandle();
    const tree = catalogFromParsed(entries);
    const indexed = toIndexedFiles(tree.files, [], "win32", `${footer.letter}:\\`);
    const digest = snapshotDigest(indexed);
    await mkdir(path.dirname(tempShard), { recursive: true });
    await writeFile(tempShard, indexed.map((file) => JSON.stringify(file)).join("\n") + (indexed.length ? "\n" : ""), "utf8");
    if (process.env.SKLAD_MFT_EXIT === "86") {
      await unlink(tempShard).catch(() => undefined);
      await writeProgress(progress, {
        phase: "failed",
        records: recordTotal,
        recordTotal,
        fileBytes: info.size,
        letter: footer.letter,
        diskId: null,
        ready: false,
        error: "crash",
      });
      process.exit(86);
    }
    if (await cancelled(cancel)) throw new Error("Импорт отменён.");
    finalShard = path.join(directory, "drive-files", `${id}.ndjson`);
    previousShard = `${finalShard}.previous`;
    try {
      await rename(finalShard, previousShard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      previousShard = null;
    }
    await rename(tempShard, finalShard);
    const shardInfo = await stat(finalShard);
    const summary = summarizeIndexed(indexed);
    summary.fileCount = tree.userFiles;
    summary.indexedBytes = tree.logicalBytes;
    if (tree.unknownSize > 0) summary.unknownSizes = tree.unknownSize;
    const disk = mftDisk({
      id,
      serial: input.serial,
      volumeUuid: input.volumeUuid,
      letter: footer.letter,
      protectedVolume,
      files: indexed,
      digest,
      shard: finalShard,
      shardBytes: shardInfo.size,
      logicalBytes: tree.logicalBytes,
      fileCount: tree.userFiles,
      summary,
    });
    const existing = await readCatalog();
    const others = existing?.disks.filter((item) => item.id !== id) ?? [];
    const previous = existing?.disks.find((item) => item.id === id);
    if (previous?.namedByUser) {
      disk.label = previous.label;
      disk.namedByUser = true;
    }
    await writeCatalog({ version: 2, seeded: true, disks: [...others, disk] });
    committed = true;
    if (previousShard) await unlink(previousShard).catch(() => undefined);
    const store = createJobStore(directory);
    const queued = await store.enqueue(
      {
        kind: "index",
        host: "mac-local",
        source: `mft:${id}:${digest}`,
        destination: `shard:${id}`,
        diskId: id,
      },
      { anyState: true },
    );
    if (queued.created && queued.job.workerToken == null) {
      const claim = await store.claim(queued.job.id, "mac-local");
      const token = claim.ok ? claim.job?.workerToken : null;
      if (token) {
        await store.markVerified(queued.job.id, token);
        await store.complete(queued.job.id, token);
      }
    }
    await mkdir(path.join(directory, "receipts"), { recursive: true });
    await writeFile(path.join(directory, "receipts", `${id}.json`), JSON.stringify({
      diskId: id,
      digest,
      files: tree.userFiles,
      dirs: tree.userDirs,
      logicalBytes: tree.logicalBytes,
      allocatedBytes: tree.allocatedBytes,
      unknownSize: tree.unknownSize,
      unknownAllocated: tree.unknownAllocated,
    }), "utf8");
    await writeProgress(progress, {
      phase: "ready",
      records: recordTotal,
      recordTotal,
      fileBytes: info.size,
      letter: footer.letter,
      diskId: id,
      ready: true,
      error: null,
    });
    const { buildDiskTree } = await import("@/addons/drives/browse");
    const root = buildDiskTree({ ...disk, files: indexed }).root;
    return {
      diskId: id,
      letter: footer.letter,
      protected: protectedVolume,
      records: recordTotal,
      badRecords,
      files: tree.userFiles,
      dirs: tree.userDirs,
      nonempty: tree.nonempty,
      explicitZero: tree.explicitZero,
      unknownSize: tree.unknownSize,
      logicalBytes: tree.logicalBytes,
      allocatedBytes: tree.allocatedBytes,
      unknownAllocated: tree.unknownAllocated,
      hardlinks: tree.hardlinks,
      wof: tree.wof,
      unresolved: tree.unresolved,
      cycles: tree.cycles,
      sequenceMismatch: tree.sequenceMismatch,
      unsafe: tree.unsafe,
      meta: tree.meta,
      rootFiles: root.fileCount,
      rootDirs: root.dirCount,
      rss: process.memoryUsage().rss,
      durationMs: Date.now() - started,
      jobCreated: queued.created,
    };
  } catch (error) {
    await closeHandle().catch(() => undefined);
    const message = error instanceof Error ? error.message : "Импорт MFT не выполнился.";
    await writeProgress(progress, {
      phase: message.includes("отменён") ? "cancelled" : "failed",
      records: 0,
      recordTotal,
      fileBytes: info.size,
      letter: footer.letter,
      diskId: null,
      ready: false,
      error: message,
    }).catch(() => undefined);
    throw error;
  } finally {
    if (!committed) {
      await unlink(tempShard).catch(() => undefined);
      if (finalShard && previousShard) {
        await unlink(finalShard).catch(() => undefined);
        await rename(previousShard, finalShard).catch(() => undefined);
      } else if (finalShard) {
        await unlink(finalShard).catch(() => undefined);
      }
    }
  }
}

export async function readMftProgress(directory = dataDir()): Promise<MftImportProgress | null> {
  try {
    return JSON.parse(await readFile(progressPath(directory), "utf8")) as MftImportProgress;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function requestMftCancel(directory = dataDir()): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(cancelPath(directory), "1", "utf8");
}

function progressPath(directory: string): string {
  return path.join(directory, "mft-import.json");
}

function cancelPath(directory: string): string {
  return path.join(directory, "mft-import.cancel");
}

async function cancelled(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeProgress(file: string, progress: MftImportProgress): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(progress), "utf8");
  await rename(tmp, file);
}

function assertExportPath(filePath: string): void {
  const text = filePath.trim();
  if (!text || text.includes("\0") || text.startsWith("\\\\.\\") || text.startsWith("//./") || /^[A-Za-z]:\\?$/.test(text)) {
    throw new Error("Нужен путь к файлу экспорта. Устройство тома не открывается.");
  }
}

function mftDisk(input: {
  id: string;
  serial: string;
  volumeUuid: string;
  letter: string;
  protectedVolume: boolean;
  files: DiskRecord["files"];
  digest: string;
  shard: string;
  shardBytes: number;
    logicalBytes: number;
    fileCount: number;
    summary: DiskRecord["summary"];
  }): DiskRecord {
  return {
    id: input.id,
    serial: input.serial,
    serialNorm: normalizeSerial(input.serial),
    volumeUuid: input.volumeUuid,
    uuidNorm: normalizeUuid(input.volumeUuid),
    filesystem: "NTFS",
    label: input.letter,
    namedByUser: false,
    volumeName: input.letter,
    totalBytes: 0,
    freeBytes: 0,
    lastSeenAt: new Date().toISOString(),
    lastHostId: "offline-snapshot",
    lastHostName: "Снимок",
    pathStyle: "win32",
    lastMountPath: `${input.letter}:\\`,
    priorMountPath: "",
    connectedHosts: [],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: {
      status: "complete",
      strategy: "mft-usn",
      progress: 1,
      message: input.protectedVolume
        ? "Офлайн-снимок. Действия по умолчанию не запускаются."
        : "Офлайн-снимок MFT. Диск не открывался.",
      elevated: false,
    },
    files: [],
    summary: input.summary,
    fileStore: input.shard,
    shardBytes: input.shardBytes,
    shardRevision: input.digest,
    indexRevision: input.digest,
    reportedRecords: input.fileCount,
    snapshotOnly: input.protectedVolume,
  };
}

export async function clearMftCancel(directory = dataDir()): Promise<void> {
  await rm(cancelPath(directory), { force: true });
}
