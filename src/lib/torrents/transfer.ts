import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open as openFile, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "@/lib/json-file";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { assertAllowedTorrentPath, windowsPathToWsl, wslPathToWindows } from "@/lib/qbittorrent/paths";
import { dataDir } from "@/lib/qbittorrent/store";

export const COPY_MISMATCH = "Копия не совпала с источником. Исходник остаётся.";

export type TransferStatus = "queued" | "running" | "paused" | "completed" | "error" | "cancelled";
export type TransferPauseReason = "user" | "busy" | "schedule" | null;
export type TransferAction = "pause" | "resume" | "cancel" | "pauseAll" | "resumeAll" | "cancelAll";

export interface TransferFile {
  relativeName: string;
  size: number;
  copiedBytes: number;
  sourcePath: string;
  destPath: string;
}

export interface TransferJob {
  id: string;
  hostId: string;
  hash: string;
  name: string;
  sourceRoot: string;
  destRoot: string;
  files: TransferFile[];
  status: TransferStatus;
  pauseReason: TransferPauseReason;
  error: string | null;
  verified: boolean;
  seedingPreserved: true;
  createdAt: number;
  updatedAt: number;
  bytesThisWindow: number;
  windowStartedAt: number;
}

export interface TransferSchedule {
  startHour: number;
  endHour: number;
}

export interface TransferPolicy {
  maxParallel: number;
  maxBytesPerSecond: number;
  chunkBytes: number;
  busy: boolean;
  schedule: TransferSchedule | null;
}

export interface TransferJobInput {
  hostId: string;
  hash: string;
  name: string;
  sourceRoot: string;
  destRoot: string;
  files: Array<Pick<TransferFile, "relativeName" | "size" | "sourcePath" | "destPath">>;
}

export type TransferCopier = (sourcePath: string, destPath: string, offset: number, length: number) => Promise<number>;

const STATUSES = new Set<TransferStatus>(["queued", "running", "paused", "completed", "error", "cancelled"]);
const ACTIONS = new Set<TransferAction>(["pause", "resume", "cancel", "pauseAll", "resumeAll", "cancelAll"]);

export function defaultTransferPolicy(): TransferPolicy {
  return {
    maxParallel: 1,
    maxBytesPerSecond: 33_554_432,
    chunkBytes: 1_048_576,
    busy: false,
    schedule: null,
  };
}

export function hashesMatch(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function scheduleAllows(schedule: TransferSchedule | null, now: number): boolean {
  if (!schedule) return true;
  const hour = new Date(now).getUTCHours();
  if (schedule.startHour === schedule.endHour) return true;
  if (schedule.startHour < schedule.endHour) return hour >= schedule.startHour && hour < schedule.endHour;
  return hour >= schedule.startHour || hour < schedule.endHour;
}

export async function loadTransferPolicy(dir = dataDir()): Promise<TransferPolicy> {
  const stored = await readJsonFile<unknown>(policyPath(dir), null);
  return revivePolicy(stored);
}

export async function saveTransferPolicy(dir: string, patch: Partial<TransferPolicy>): Promise<TransferPolicy> {
  const current = await loadTransferPolicy(dir);
  const next: TransferPolicy = { ...current };
  if (patch.maxParallel !== undefined) next.maxParallel = requirePositiveInt(patch.maxParallel, "Число одновременных переносов — целое число от 1.");
  if (patch.maxBytesPerSecond !== undefined) {
    next.maxBytesPerSecond = requirePositiveInt(patch.maxBytesPerSecond, "Ограничение скорости должно быть больше нуля.");
  }
  if (patch.chunkBytes !== undefined) next.chunkBytes = requirePositiveInt(patch.chunkBytes, "Размер блока должен быть больше нуля.");
  if (patch.busy !== undefined) {
    if (typeof patch.busy !== "boolean") throw new QbittorrentError("validation", "Флаг занятости должен быть да или нет.");
    next.busy = patch.busy;
  }
  if (patch.schedule !== undefined) next.schedule = requireSchedule(patch.schedule);
  await writeJsonFile(policyPath(dir), next);
  return next;
}

export async function listTransferJobs(dir = dataDir()): Promise<TransferJob[]> {
  const stored = await readJsonFile<{ jobs?: unknown }>(jobsPath(dir), { jobs: [] });
  const rows = Array.isArray(stored?.jobs) ? stored.jobs : [];
  return rows.flatMap((row) => {
    const job = reviveJob(row);
    return job ? [job] : [];
  }).sort(byAge);
}

export async function createTransferJob(dir: string, input: TransferJobInput, now: number): Promise<TransferJob> {
  const sourceRoot = requireDirectory(input.sourceRoot, "Укажите исходный каталог.");
  const destRoot = requireDirectory(input.destRoot, "Укажите каталог назначения.");
  if (sameLocation(sourceRoot, destRoot)) {
    throw new QbittorrentError("validation", "Каталог назначения совпадает с исходным.");
  }
  if (insideLocation(destRoot, sourceRoot)) {
    throw new QbittorrentError("validation", "Каталог назначения находится внутри исходного.");
  }
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new QbittorrentError("validation", "В раздаче нет файлов для переноса.");
  }
  const files = input.files.map((file) => {
    assertRelative(file.relativeName);
    if (!Number.isFinite(file.size) || file.size < 0) {
      throw new QbittorrentError("validation", "Некорректный размер файла.");
    }
    const sourcePath = requireDirectory(file.sourcePath, "Укажите исходный файл.");
    const destPath = requireDirectory(file.destPath, "Укажите файл назначения.");
    if (sameLocation(sourcePath, destPath)) {
      throw new QbittorrentError("validation", "Файл назначения совпадает с исходным.");
    }
    return {
      relativeName: file.relativeName,
      size: file.size,
      copiedBytes: 0,
      sourcePath,
      destPath,
    };
  });
  const job: TransferJob = {
    id: randomUUID(),
    hostId: input.hostId,
    hash: input.hash,
    name: input.name.trim() || "Раздача",
    sourceRoot,
    destRoot,
    files,
    status: "queued",
    pauseReason: null,
    error: null,
    verified: false,
    seedingPreserved: true,
    createdAt: now,
    updatedAt: now,
    bytesThisWindow: 0,
    windowStartedAt: now,
  };
  const jobs = await listTransferJobs(dir);
  jobs.push(job);
  await writeJobs(dir, jobs);
  return job;
}

export async function controlTransferJob(dir: string, action: TransferAction, id: string, now: number): Promise<TransferJob[]> {
  if (!ACTIONS.has(action)) throw new QbittorrentError("validation", "Неизвестное действие.");
  const jobs = await listTransferJobs(dir);
  const all = action.endsWith("All");
  const verb = (all ? action.slice(0, -3) : action) as "pause" | "resume" | "cancel";
  const policy = verb === "resume" ? await loadTransferPolicy(dir) : null;
  const targets = all ? jobs : jobs.filter((job) => job.id === id);
  if (!all) {
    if (!id) throw new QbittorrentError("validation", "Не указана задача переноса.");
    if (targets.length === 0) throw new QbittorrentError("not_found", "Задача переноса не найдена.");
  }
  for (const job of targets) {
    if (verb === "pause") pauseJob(job, now);
    else if (verb === "resume") resumeJob(job, policy ?? defaultTransferPolicy(), now);
    else cancelJob(job, now);
  }
  await writeJobs(dir, jobs);
  return jobs;
}

export async function controlTorrentTransfer(publicId: string, action: TransferAction, dir = dataDir()): Promise<TransferJob[]> {
  const prefix = "torrent-transfer__";
  const id = publicId.startsWith(prefix) ? publicId.slice(prefix.length) : publicId;
  return controlTransferJob(dir, action, id, Date.now());
}

export async function stepTorrentTransfers(dir: string, now: number, copier: TransferCopier = copyFileChunk): Promise<TransferJob[]> {
  const policy = await loadTransferPolicy(dir);
  const jobs = await listTransferJobs(dir);
  if (policy.busy) {
    for (const job of jobs) {
      if (job.status !== "running") continue;
      job.status = "paused";
      job.pauseReason = "busy";
      job.updatedAt = now;
    }
    await writeJobs(dir, jobs);
    return jobs;
  }
  if (!scheduleAllows(policy.schedule, now)) {
    for (const job of jobs) {
      if (job.status !== "running" && job.status !== "queued") continue;
      job.status = "paused";
      job.pauseReason = "schedule";
      job.updatedAt = now;
    }
    await writeJobs(dir, jobs);
    return jobs;
  }

  for (const job of jobs) {
    if (job.status === "paused" && (job.pauseReason === "busy" || job.pauseReason === "schedule")) {
      job.status = "queued";
      job.pauseReason = null;
      job.updatedAt = now;
    }
  }

  const running = jobs.filter((job) => job.status === "running");
  for (const job of jobs.filter((item) => item.status === "queued").sort(byAge)) {
    if (running.length >= policy.maxParallel) break;
    if (!(await sourcesPresent(job))) continue;
    job.status = "running";
    job.pauseReason = null;
    job.updatedAt = now;
    running.push(job);
  }
  for (const job of running.sort(byAge)) {
    if (!(await sourcesPresent(job))) {
      job.status = "queued";
      job.updatedAt = now;
      continue;
    }
    await advanceJob(job, policy, now, copier);
    break;
  }
  await writeJobs(dir, jobs);
  return jobs;
}

async function advanceJob(job: TransferJob, policy: TransferPolicy, now: number, copier: TransferCopier): Promise<void> {
  openWindow(job, now);
  if (fullyCopied(job)) {
    await verifyJob(job, now);
    return;
  }
  const budget = policy.maxBytesPerSecond - job.bytesThisWindow;
  if (budget <= 0) return;
  const file = job.files.find((item) => item.copiedBytes < item.size);
  if (!file) {
    await verifyJob(job, now);
    return;
  }
  const length = Math.min(policy.chunkBytes, budget, file.size - file.copiedBytes);
  if (length <= 0) return;
  let written = 0;
  try {
    written = await copier(file.sourcePath, file.destPath, file.copiedBytes, length);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      job.status = "queued";
      job.updatedAt = now;
      return;
    }
    throw error;
  }
  const gained = Math.max(0, Math.min(length, Math.floor(written)));
  if (gained <= 0) {
    job.status = "error";
    job.error = "Не удалось прочитать источник. Исходник остаётся.";
    job.pauseReason = null;
    job.updatedAt = now;
    return;
  }
  file.copiedBytes += gained;
  job.bytesThisWindow += gained;
  job.updatedAt = now;
  if (fullyCopied(job)) await verifyJob(job, now);
}

async function verifyJob(job: TransferJob, now: number): Promise<void> {
  for (const file of job.files) {
    if (file.size === 0) {
      const created = await openDestination(file.destPath);
      await created.close();
    }
    let sourceHash: Buffer;
    let destHash: Buffer;
    try {
      sourceHash = await hashFile(file.sourcePath);
      destHash = await hashFile(file.destPath);
    } catch {
      job.status = "error";
      job.verified = false;
      job.error = "Не удалось проверить копию. Исходник остаётся.";
      job.pauseReason = null;
      job.updatedAt = now;
      return;
    }
    if (!hashesMatch(sourceHash, destHash)) {
      job.status = "error";
      job.verified = false;
      job.error = COPY_MISMATCH;
      job.pauseReason = null;
      job.updatedAt = now;
      return;
    }
  }
  job.status = "completed";
  job.verified = true;
  job.error = null;
  job.pauseReason = null;
  job.updatedAt = now;
}

async function hashFile(file: string): Promise<Buffer> {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest();
}

async function copyFileChunk(sourcePath: string, destPath: string, offset: number, length: number): Promise<number> {
  if (length <= 0) return 0;
  const destination = await openDestination(destPath);
  let source: FileHandle | null = null;
  try {
    source = await openFile(sourcePath, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await source.read(buffer, 0, length, offset);
    if (bytesRead <= 0) return 0;
    const { bytesWritten } = await destination.write(buffer, 0, bytesRead, offset);
    return bytesWritten;
  } finally {
    await source?.close();
    await destination.close();
  }
}

async function openDestination(dest: string): Promise<FileHandle> {
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    const created = await openFile(dest, "wx");
    await created.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return openFile(dest, "r+");
}

async function sourcesPresent(job: TransferJob): Promise<boolean> {
  for (const file of job.files) {
    try {
      const info = await stat(file.sourcePath);
      if (!info.isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return job.files.length > 0;
}

function fullyCopied(job: TransferJob): boolean {
  return job.files.length > 0 && job.files.every((file) => file.copiedBytes >= file.size);
}

function openWindow(job: TransferJob, now: number): void {
  if (job.windowStartedAt > now || now - job.windowStartedAt >= 1000) {
    job.windowStartedAt = now;
    job.bytesThisWindow = 0;
  }
}

function pauseJob(job: TransferJob, now: number): void {
  if (job.status !== "queued" && job.status !== "running") return;
  job.status = "paused";
  job.pauseReason = "user";
  job.updatedAt = now;
}

function resumeJob(job: TransferJob, policy: TransferPolicy, now: number): void {
  if (job.status !== "paused") return;
  if (policy.busy) {
    job.pauseReason = "busy";
    job.updatedAt = now;
    return;
  }
  if (!scheduleAllows(policy.schedule, now)) {
    job.pauseReason = "schedule";
    job.updatedAt = now;
    return;
  }
  job.status = "running";
  job.pauseReason = null;
  job.updatedAt = now;
}

function cancelJob(job: TransferJob, now: number): void {
  if (job.status === "completed" || job.status === "cancelled" || job.status === "error") return;
  job.status = "cancelled";
  job.pauseReason = null;
  job.updatedAt = now;
}

function requireDirectory(input: string, emptyMessage: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new QbittorrentError("validation", emptyMessage);
  assertAllowedTorrentPath(trimmed);
  return trimmed;
}

function assertRelative(name: string): void {
  if (!name || !name.trim() || name.split(/[\\/]/).includes("..")) {
    throw new QbittorrentError("validation", "Некорректное имя файла в раздаче.");
  }
}

function sameLocation(left: string, right: string): boolean {
  return canonicalLocation(left) === canonicalLocation(right);
}

function insideLocation(child: string, parent: string): boolean {
  const next = canonicalLocation(child);
  const root = canonicalLocation(parent);
  if (!next || !root || next === root) return false;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return next.startsWith(prefix);
}

function canonicalLocation(input: string): string {
  const fromWindows = windowsPathToWsl(input);
  const fromWsl = fromWindows ? null : wslPathToWindows(input);
  const asWsl = fromWindows ?? (fromWsl ? windowsPathToWsl(fromWsl) : null);
  const text = (asWsl ?? input).trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const drive = !asWsl ? /^([a-zA-Z]):\/?(.*)$/.exec(text) : null;
  const absolute = Boolean(asWsl) || text.startsWith("/");
  const body = asWsl ? asWsl.replace(/^\/+/, "") : drive ? drive[2] ?? "" : text.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/").toLowerCase();
  if (asWsl || (absolute && !drive)) return joined ? `/${joined}` : "/";
  if (drive) return joined ? `${drive[1].toLowerCase()}:/${joined}` : `${drive[1].toLowerCase()}:/`;
  return joined;
}

function requirePositiveInt(value: number, message: string): number {
  if (!Number.isInteger(value) || value < 1) throw new QbittorrentError("validation", message);
  return value;
}

function requireSchedule(schedule: TransferSchedule | null): TransferSchedule | null {
  if (schedule === null) return null;
  if (!schedule || typeof schedule !== "object") {
    throw new QbittorrentError("validation", "Часы расписания — целые числа от 0 до 23.");
  }
  if (!validHour(schedule.startHour) || !validHour(schedule.endHour)) {
    throw new QbittorrentError("validation", "Часы расписания — целые числа от 0 до 23.");
  }
  return { startHour: schedule.startHour, endHour: schedule.endHour };
}

function validHour(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

function revivePolicy(value: unknown): TransferPolicy {
  const defaults = defaultTransferPolicy();
  if (!value || typeof value !== "object") return defaults;
  const raw = value as Partial<TransferPolicy>;
  return {
    maxParallel: positiveOr(raw.maxParallel, defaults.maxParallel),
    maxBytesPerSecond: positiveOr(raw.maxBytesPerSecond, defaults.maxBytesPerSecond),
    chunkBytes: positiveOr(raw.chunkBytes, defaults.chunkBytes),
    busy: raw.busy === true,
    schedule: reviveSchedule(raw.schedule),
  };
}

function reviveSchedule(value: unknown): TransferSchedule | null {
  if (!value || typeof value !== "object") return null;
  const schedule = value as Partial<TransferSchedule>;
  if (!validHour(schedule.startHour ?? -1) || !validHour(schedule.endHour ?? -1)) return null;
  return { startHour: schedule.startHour as number, endHour: schedule.endHour as number };
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function reviveJob(value: unknown): TransferJob | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TransferJob>;
  if (typeof raw.id !== "string" || typeof raw.hostId !== "string" || !Array.isArray(raw.files)) return null;
  const status = STATUSES.has(raw.status as TransferStatus) ? (raw.status as TransferStatus) : "queued";
  const pauseReason = raw.pauseReason === "user" || raw.pauseReason === "busy" || raw.pauseReason === "schedule" ? raw.pauseReason : null;
  return {
    id: raw.id,
    hostId: raw.hostId,
    hash: typeof raw.hash === "string" ? raw.hash : "",
    name: typeof raw.name === "string" ? raw.name : "Раздача",
    sourceRoot: typeof raw.sourceRoot === "string" ? raw.sourceRoot : "",
    destRoot: typeof raw.destRoot === "string" ? raw.destRoot : "",
    files: raw.files.flatMap((file) => {
      if (!file || typeof file !== "object") return [];
      const row = file as Partial<TransferFile>;
      if (typeof row.relativeName !== "string" || typeof row.sourcePath !== "string" || typeof row.destPath !== "string") return [];
      return [
        {
          relativeName: row.relativeName,
          size: typeof row.size === "number" && row.size >= 0 ? row.size : 0,
          copiedBytes: typeof row.copiedBytes === "number" && row.copiedBytes >= 0 ? row.copiedBytes : 0,
          sourcePath: row.sourcePath,
          destPath: row.destPath,
        },
      ];
    }),
    status,
    pauseReason,
    error: typeof raw.error === "string" ? raw.error : null,
    verified: raw.verified === true,
    seedingPreserved: true,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    bytesThisWindow: typeof raw.bytesThisWindow === "number" && raw.bytesThisWindow >= 0 ? raw.bytesThisWindow : 0,
    windowStartedAt: typeof raw.windowStartedAt === "number" ? raw.windowStartedAt : 0,
  };
}

function byAge(left: TransferJob, right: TransferJob): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

async function writeJobs(dir: string, jobs: TransferJob[]): Promise<void> {
  await writeJsonFile(jobsPath(dir), { jobs });
}

function jobsPath(dir: string): string {
  return path.join(dir, "torrent-transfers.json");
}

function policyPath(dir: string): string {
  return path.join(dir, "torrent-transfer-policy.json");
}
