import { createHash, type Hash } from "node:crypto";
import { mkdir, open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { requestDiskRescan } from "@/addons/drives/rescan";
import { readCatalog } from "@/addons/drives/store";
import { loadDriveCatalog } from "@/lib/drives/catalog";
import type { CatalogDisk } from "@/lib/drives/types";
import { enqueuePolicyJob } from "@/lib/policies/jobs";
import { loadPolicy } from "@/lib/policies/store";
import type { PolicyRules } from "@/lib/policies/types";
import { clientFor, requireHost } from "@/lib/qbittorrent/service";
import { enqueueEncode } from "@/lib/transcode/encode-worker";

import type { PipelineEffects } from "@/lib/scheduler/auto-queue";
import { isSkippedVolume, skippedVolumeNote } from "@/lib/scheduler/skipped-volume";

export const pipelineBudget = { chunkBytes: 256 * 1024 };

const hashers = new Map<string, { hash: Hash; offset: number }>();
let catalogFiles: { diskId: string; files: { relativePath: string }[] } | null = null;

export function resetPipelineEffectsForTests(): void {
  hashers.clear();
  catalogFiles = null;
  pipelineBudget.chunkBytes = 256 * 1024;
}

export const pipelineEffects: PipelineEffects = {
  requestIndex,
  readDir,
  kindOf,
  copyChunk,
  hashChunk,
  nextCatalogTops,
  torrentFiles,
  enqueueCompress,
  context,
};

async function requestIndex(diskId: string | null): Promise<string> {
  if (!diskId) return "Диск в каталоге не найден. Индекс запросим, когда он появится.";
  if (process.env.VITEST) return "Индекс поставлен в очередь.";
  try {
    const result = await requestDiskRescan(diskId);
    return result.message;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Индекс не запущен.";
    return isSkippedVolume(message) ? skippedVolumeNote(message) : message;
  }
}

async function readDir(dir: string): Promise<string[]> {
  if (isSkippedVolume(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((entry) => entry.name).filter((name) => name !== "." && name !== "..");
}

async function kindOf(filePath: string): Promise<"file" | "dir" | "missing"> {
  if (isSkippedVolume(filePath)) return "missing";
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) return "dir";
    if (info.isFile()) return "file";
    return "missing";
  } catch {
    return "missing";
  }
}

async function copyChunk(source: string, dest: string, offset: number): Promise<{ offset: number; done: boolean; total: number }> {
  if (isSkippedVolume(source) || isSkippedVolume(dest)) throw new Error(skippedVolumeNote(isSkippedVolume(source) ? source : dest));
  const info = await stat(source);
  if (!info.isFile()) throw new Error("В копию попадает только файл.");
  if (offset === 0) {
    await mkdir(path.dirname(dest), { recursive: true });
    const created = await open(dest, "w");
    await created.close();
  }
  const src = await open(source, "r");
  const dst = await open(dest, "r+");
  try {
    const size = Math.max(1, pipelineBudget.chunkBytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await src.read(buffer, 0, buffer.length, offset);
    if (bytesRead > 0) await dst.write(buffer, 0, bytesRead, offset);
    const next = offset + bytesRead;
    return { offset: next, done: next >= info.size, total: info.size };
  } finally {
    await src.close();
    await dst.close();
  }
}

async function hashChunk(token: string, filePath: string, offset: number): Promise<{ offset: number; done: boolean; total: number; hex: string | null }> {
  if (isSkippedVolume(filePath)) throw new Error(skippedVolumeNote(filePath));
  const info = await stat(filePath);
  let entry = hashers.get(token);
  if (!entry || (offset === 0 && entry.offset !== 0)) {
    entry = { hash: createHash("sha256"), offset: 0 };
    hashers.set(token, entry);
  }
  const handle = await open(filePath, "r");
  try {
    const size = Math.max(1, pipelineBudget.chunkBytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
    if (bytesRead > 0) entry.hash.update(buffer.subarray(0, bytesRead));
    entry.offset += bytesRead;
    const done = info.size === 0 ? true : entry.offset >= info.size;
    if (!done) return { offset: entry.offset, done: false, total: info.size, hex: null };
    const hex = entry.hash.digest("hex");
    hashers.delete(token);
    return { offset: entry.offset, done: true, total: info.size, hex };
  } finally {
    await handle.close();
  }
}

async function nextCatalogTops(diskId: string, cursor: number): Promise<{ names: string[]; next: number; done: boolean }> {
  if (!diskId) return { names: [], next: cursor, done: true };
  if (!catalogFiles || catalogFiles.diskId !== diskId) {
    const stored = await readCatalog();
    const disk = stored?.disks.find((item) => item.id === diskId);
    catalogFiles = { diskId, files: disk?.files ?? [] };
  }
  const files = catalogFiles.files;
  const limit = 80;
  const slice = files.slice(cursor, cursor + limit);
  const names: string[] = [];
  for (const file of slice) {
    const top = (file.relativePath || "").replace(/\\/g, "/").split("/").find(Boolean);
    if (top && top !== "$RECYCLE.BIN" && top.toLowerCase() !== "system volume information") names.push(top);
  }
  const next = cursor + slice.length;
  const done = next >= files.length;
  if (done) catalogFiles = null;
  return { names, next, done };
}

async function torrentFiles(hostId: string, hash: string): Promise<{ name: string; size: number }[]> {
  if (!hostId || !hash) return [];
  try {
    const host = await requireHost(hostId);
    const client = clientFor(host);
    const files = await client.listFiles(hash);
    return files.map((file) => ({ name: file.name, size: file.size }));
  } catch {
    return [];
  }
}

async function enqueueCompress(input: {
  action: "handbrake" | "compact";
  title: string;
  hostId: string;
  hash: string;
  source: string;
  output: string;
  videoFile: string | null;
}): Promise<string> {
  if (isSkippedVolume(input.source) || isSkippedVolume(input.output) || isSkippedVolume(input.videoFile)) {
    const hit = [input.source, input.output, input.videoFile ?? ""].find((item) => isSkippedVolume(item)) ?? "";
    return skippedVolumeNote(hit);
  }
  await enqueuePolicyJob({
    kind: input.action === "handbrake" ? "handbrake" : "compact",
    torrentName: input.title,
    hostId: input.hostId,
    hash: input.hash || "pipeline",
    sourcePath: input.source,
    outputPath: input.output,
    note: "Исходник не удаляется.",
  });
  if (process.env.VITEST || input.action !== "handbrake" || !input.videoFile) {
    return input.action === "compact"
      ? "Сжатие NTFS поставлено в очередь отдельной копией. Исходник не удаляется."
      : "HandBrake поставлен в очередь. Исходник не удаляется.";
  }
  try {
    const queued = await enqueueEncode({
      source: input.videoFile,
      destination: input.output.endsWith(".mkv") || input.output.endsWith(".mp4") ? input.output : `${input.output}.mkv`,
      codec: "av1",
      allowSoftware: true,
      ...(input.hash ? { torrentHash: input.hash } : {}),
    });
    if (queued.ok === true) return "HandBrake принял файл. Исходник не удаляется.";
    const reason = typeof queued.error === "string" ? queued.error : "кодирование не стартовало";
    return `HandBrake в очереди политики. ${reason} Исходник не удаляется.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "кодирование не стартовало";
    return `HandBrake в очереди политики. ${message} Исходник не удаляется.`;
  }
}

async function context(): Promise<{ rules: PolicyRules; disks: CatalogDisk[] }> {
  const [policy, disks] = await Promise.all([loadPolicy(), loadDriveCatalog()]);
  return { rules: policy.rules, disks };
}
