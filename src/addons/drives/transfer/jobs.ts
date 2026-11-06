import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open as openFs, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { displayDiskPickerLabel, displayDiskTitle, isBrowsableDisk, isRemovableDisk } from "@/addons/drives/inventory";
import { mountPathsOf, online } from "@/addons/drives/reconcile";
import { getShelf } from "@/addons/drives/service";
import { readAgentConfig, readCatalog } from "@/addons/drives/store";
import { safeRelativePath, uniqueFileName } from "@/addons/drives/transfer/paths";
import type { AgentEndpoint, DiskRecord, DiskView } from "@/addons/drives/types";
import { DriveError } from "@/addons/drives/types";
import { registerJobSource } from "@/lib/progress/sources";
import type { JobSnapshot } from "@/lib/progress/types";

export type TransferDestKind = "browser" | "mac-downloads" | "disk";

export interface TransferDestination {
  id: string;
  kind: TransferDestKind;
  label: string;
  detail: string;
  hostId: string;
  hostName: string;
  diskId?: string;
  online: boolean;
  freeBytes: number;
  totalBytes: number;
}

export interface TransferJob {
  id: string;
  status: "queued" | "running" | "completed" | "error" | "cancelled";
  title: string;
  sourceDiskId: string;
  sourcePath: string;
  destinationId: string;
  destinationLabel: string;
  destPath: string | null;
  bytesDone: number;
  bytesTotal: number;
  speed: number;
  sourceSha256: string | null;
  destSha256: string | null;
  verified: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

const jobs = new Map<string, TransferJob>();
const MAC_DOWNLOADS = process.env.SKLAD_MAC_DOWNLOADS || path.join("/Users/uzer/Downloads");

export function listTransferJobs(): TransferJob[] {
  return [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getTransferJob(id: string): TransferJob | null {
  return jobs.get(id) ?? null;
}

function toSnapshot(job: TransferJob): JobSnapshot {
  const progress = job.bytesTotal > 0 ? Math.min(1, job.bytesDone / job.bytesTotal) : job.status === "completed" ? 1 : 0;
  return {
    id: `transfer__${job.id}`,
    kind: "copy",
    title: job.title,
    status:
      job.status === "completed"
        ? "completed"
        : job.status === "error"
          ? "error"
          : job.status === "cancelled"
            ? "cancelled"
            : job.status === "queued"
              ? "queued"
              : "running",
    progress,
    processedBytes: job.bytesDone,
    totalBytes: job.bytesTotal,
    speed: job.speed,
    eta: job.speed > 0 && job.bytesTotal > job.bytesDone ? Math.round((job.bytesTotal - job.bytesDone) / job.speed) : 8_640_000,
    currentFile: job.sourcePath,
    host: job.destinationLabel,
    diskLabel: job.destinationLabel,
    outputPath: job.destPath,
    error: job.error,
    capabilities: { pause: false, resume: false, cancel: job.status === "running" || job.status === "queued" },
    pauseUnsupportedReason: "Копирование файла нельзя поставить на паузу",
    updatedAt: job.updatedAt,
  };
}

let registered = false;
export function registerTransferProgress(): void {
  if (registered) return;
  registered = true;
  registerJobSource({
    id: "disk-transfer",
    list: () => listTransferJobs().map(toSnapshot),
  });
}

function mountsOfView(disk: DiskView): string[] {
  return [...disk.mountPaths, disk.lastMountPath].filter(Boolean);
}

function isCopyTarget(disk: DiskView): boolean {
  const mounts = mountsOfView(disk);
  if (!disk.online) return false;
  if (disk.totalBytes <= 0 && disk.freeBytes <= 0) return false;
  if (!isBrowsableDisk(disk)) return false;
  if (mounts.every((mount) => /\/System\/Volumes\//.test(mount))) return false;
  if (mounts.some((mount) => mount === "/" || mount === "/System/Volumes/Data")) return false;
  if (isRemovableDisk(disk)) return true;
  if (mounts.some((mount) => mount.startsWith("/Volumes/"))) return true;
  if (/^[A-Za-z]:\\?/.test(disk.lastMountPath) || mounts.some((m) => /^[A-Za-z]:\\?/.test(m))) return disk.totalBytes > 0;
  return disk.fileCount > 0 || disk.totalBytes > 1_000_000_000;
}

export async function listDestinations(sourceDiskId?: string | null): Promise<TransferDestination[]> {
  registerTransferProgress();
  const shelf = await getShelf();
  const out: TransferDestination[] = [
    {
      id: "browser",
      kind: "browser",
      label: "На этот компьютер (через браузер)",
      detail: "Скачивание в загрузки браузера",
      hostId: "browser",
      hostName: "Этот браузер",
      online: true,
      freeBytes: 0,
      totalBytes: 0,
    },
    {
      id: "mac-downloads",
      kind: "mac-downloads",
      label: "Mac mini · Загрузки",
      detail: MAC_DOWNLOADS,
      hostId: "mac-mini",
      hostName: "Mac mini",
      online: true,
      freeBytes: 0,
      totalBytes: 0,
    },
  ];
  for (const disk of shelf.disks) {
    if (sourceDiskId && disk.id === sourceDiskId) continue;
    if (!disk.online) continue;
    if (!isCopyTarget(disk)) continue;
    out.push({
      id: `disk:${disk.id}`,
      kind: "disk",
      label: displayDiskPickerLabel(disk),
      detail: disk.mountPaths[0] || disk.lastMountPath,
      hostId: disk.lastHostId,
      hostName: disk.lastHostName || disk.lastHostId,
      diskId: disk.id,
      online: disk.online,
      freeBytes: disk.freeBytes,
      totalBytes: disk.totalBytes,
    });
  }
  return out;
}

async function findDisk(diskId: string): Promise<DiskRecord> {
  let stored = await readCatalog();
  if (!stored) {
    await getShelf();
    stored = await readCatalog();
  }
  const disk = stored?.disks.find((item) => item.id === diskId);
  if (!disk) throw new DriveError(404, "Диск не найден в каталоге.");
  return disk;
}

async function agentForDisk(disk: DiskRecord): Promise<AgentEndpoint> {
  const config = await readAgentConfig();
  const byId = config.agents.find((item) => item.id === disk.lastHostId);
  if (byId) return byId;
  const byOs = config.agents.find((item) => item.os === (disk.pathStyle === "win32" ? "win32" : "darwin"));
  if (byOs) return byOs;
  throw new DriveError(502, "Агент для диска не настроен.");
}

export async function enqueueCopy(input: { diskId: string; path: string; destinationId: string }): Promise<TransferJob> {
  registerTransferProgress();
  const relative = safeRelativePath(input.path);
  if (!relative) throw new DriveError(400, "Некорректный путь файла.");
  const disk = await findDisk(input.diskId);
  if (!online(disk)) throw new DriveError(409, "Нужен подключённый диск.");
  const file = disk.files.find((item) => item.kind === "file" && safeRelativePath(item.relativePath) === relative);
  if (!file) throw new DriveError(404, "Файл не найден в снимке каталога.");
  if (input.destinationId === "browser") {
    throw new DriveError(400, "Для браузера откройте поток скачивания.");
  }
  const destinations = await listDestinations(disk.id);
  const destination = destinations.find((item) => item.id === input.destinationId);
  if (!destination) throw new DriveError(404, "Назначение не найдено или недоступно.");
  if (!destination.online) throw new DriveError(409, "Назначение сейчас офлайн.");

  const name = file.name || relative.split("/").pop() || "file";
  const job: TransferJob = {
    id: randomUUID(),
    status: "queued",
    title: `Копирование · ${name}`,
    sourceDiskId: disk.id,
    sourcePath: relative,
    destinationId: destination.id,
    destinationLabel: destination.label,
    destPath: null,
    bytesDone: 0,
    bytesTotal: file.size > 0 ? file.size : 0,
    speed: 0,
    sourceSha256: null,
    destSha256: null,
    verified: false,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  void runCopyJob(job.id).catch((error) => {
    const current = jobs.get(job.id);
    if (!current) return;
    current.status = "error";
    current.error = error instanceof Error ? error.message : "Копирование не удалось.";
    current.updatedAt = Date.now();
    current.finishedAt = Date.now();
  });
  return job;
}

async function runCopyJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job || job.status === "cancelled") return;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  const disk = await findDisk(job.sourceDiskId);
  const agent = await agentForDisk(disk);
  const relative = job.sourcePath;
  const started = Date.now();

  const sourceUrl = new URL(`${agent.url.replace(/\/$/, "")}/v1/file/content`);
  sourceUrl.searchParams.set("serial", disk.serial);
  sourceUrl.searchParams.set("uuid", disk.volumeUuid);
  sourceUrl.searchParams.set("path", relative);

  const response = await fetch(sourceUrl, { cache: "no-store" });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    if (response.status === 404 && /Неизвестный путь|unknown/i.test(text)) {
      throw new DriveError(502, "Агент Windows без /v1/file/content. Обновите репозиторий на ПК и перезапустите агент на порту 4372.");
    }
    let message = text;
    try { message = (JSON.parse(text) as { error?: string }).error || text; } catch { /* keep */ }
    throw new DriveError(502, message || `Агент источника ответил ${response.status}.`);
  }
  const declared = Number(response.headers.get("x-sklad-size") || response.headers.get("content-length") || "0");
  if (declared > 0) job.bytesTotal = declared;

  const sourceHash = createHash("sha256");
  let bytes = 0;
  const tracker = new Transform({
    transform(chunk, _enc, cb) {
      if (job.status === "cancelled") {
        cb(new Error("Отменено"));
        return;
      }
      sourceHash.update(chunk);
      bytes += chunk.length;
      job.bytesDone = bytes;
      const elapsed = Math.max(0.001, (Date.now() - started) / 1000);
      job.speed = bytes / elapsed;
      job.updatedAt = Date.now();
      cb(null, chunk);
    },
  });

  if (job.destinationId === "mac-downloads") {
    await mkdir(MAC_DOWNLOADS, { recursive: true });
    const base = relative.split("/").pop() || "file";
    const finalName = uniqueFileName(MAC_DOWNLOADS, base, existsSync);
    const finalPath = path.join(MAC_DOWNLOADS, finalName);
    const tmp = `${finalPath}.sklad-part`;
    const nodeIn = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    await pipeline(nodeIn, tracker, createWriteStream(tmp));
    job.sourceSha256 = sourceHash.digest("hex");
    const destHash = createHash("sha256");
    const fd = await openFs(tmp, "r");
    try {
      for await (const chunk of fd.createReadStream()) destHash.update(chunk);
    } finally {
      await fd.close();
    }
    job.destSha256 = destHash.digest("hex");
    if (job.destSha256 !== job.sourceSha256) {
      throw new DriveError(500, "SHA-256 источника и копии не совпали.");
    }
    await rename(tmp, finalPath);
    const info = await stat(finalPath);
    job.bytesDone = info.size;
    job.bytesTotal = info.size;
    job.destPath = finalPath;
    job.verified = true;
    job.status = "completed";
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    return;
  }

  if (job.destinationId.startsWith("disk:")) {
    const destDiskId = job.destinationId.slice("disk:".length);
    const destDisk = await findDisk(destDiskId);
    if (!online(destDisk)) throw new DriveError(409, "Диск назначения офлайн.");
    const destAgent = await agentForDisk(destDisk);
    const base = relative.split("/").pop() || "file";
    let destRelative = base;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = new URL(`${destAgent.url.replace(/\/$/, "")}/v1/file/stat`);
      probe.searchParams.set("serial", destDisk.serial);
      probe.searchParams.set("uuid", destDisk.volumeUuid);
      probe.searchParams.set("path", destRelative);
      const st = await fetch(probe, { cache: "no-store" });
      if (st.status === 404) break;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      destRelative = attempt === 0 ? `${stem}-${stamp}${ext}` : `${stem}-${stamp}-${attempt}${ext}`;
    }
    const putUrl = new URL(`${destAgent.url.replace(/\/$/, "")}/v1/file/content`);
    putUrl.searchParams.set("serial", destDisk.serial);
    putUrl.searchParams.set("uuid", destDisk.volumeUuid);
    putUrl.searchParams.set("path", destRelative);
    const nodeIn = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    const hashed = nodeIn.pipe(tracker);
    const put = await fetch(putUrl, {
      method: "PUT",
      body: Readable.toWeb(hashed) as unknown as BodyInit,
      duplex: "half",
      headers: { "content-type": "application/octet-stream" },
    } as RequestInit & { duplex: "half" });
    job.sourceSha256 = sourceHash.digest("hex");
    if (!put.ok) {
      const text = await put.text().catch(() => "");
      throw new DriveError(502, text || `Агент назначения ответил ${put.status}.`);
    }
    const result = (await put.json()) as { sha256?: string; bytes?: number; relativePath?: string };
    job.destSha256 = result.sha256 || null;
    job.bytesDone = result.bytes || bytes;
    if (job.bytesTotal <= 0 && result.bytes) job.bytesTotal = result.bytes;
    if (!job.destSha256 || job.destSha256 !== job.sourceSha256) {
      throw new DriveError(500, "SHA-256 источника и копии не совпали.");
    }
    job.destPath = result.relativePath || destRelative;
    job.verified = true;
    job.status = "completed";
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    return;
  }

  throw new DriveError(400, "Неизвестное назначение.");
}

export async function openBrowserDownload(
  diskId: string,
  relativeRaw: string,
): Promise<{ stream: ReadableStream; filename: string; size: number | null; sourceDiskLabel: string }> {
  const relative = safeRelativePath(relativeRaw);
  if (!relative) throw new DriveError(400, "Некорректный путь файла.");
  const disk = await findDisk(diskId);
  if (!online(disk)) throw new DriveError(409, "Нужен подключённый диск.");
  const agent = await agentForDisk(disk);
  const sourceUrl = new URL(`${agent.url.replace(/\/$/, "")}/v1/file/content`);
  sourceUrl.searchParams.set("serial", disk.serial);
  sourceUrl.searchParams.set("uuid", disk.volumeUuid);
  sourceUrl.searchParams.set("path", relative);
  const response = await fetch(sourceUrl, { cache: "no-store" });
  if (!response.ok || !response.body) throw new DriveError(502, `Агент ответил ${response.status}.`);
  const sizeHeader = response.headers.get("content-length");
  return {
    stream: response.body,
    filename: relative.split("/").pop() || "file",
    size: sizeHeader ? Number(sizeHeader) : null,
    sourceDiskLabel: displayDiskTitle({
      label: disk.label,
      volumeName: disk.volumeName,
      lastMountPath: disk.lastMountPath,
      mountPaths: [...mountPathsOf(disk), disk.lastMountPath].filter(Boolean),
      totalBytes: disk.totalBytes,
      filesystem: disk.filesystem,
    }),
  };
}

export function cancelTransferJob(id: string): boolean {
  const key = id.startsWith("transfer__") ? id.slice("transfer__".length) : id;
  const job = jobs.get(key);
  if (!job) return false;
  if (job.status !== "running" && job.status !== "queued") return false;
  job.status = "cancelled";
  job.error = "Отменено. Исходный файл не удалялся.";
  job.updatedAt = Date.now();
  job.finishedAt = Date.now();
  return true;
}
