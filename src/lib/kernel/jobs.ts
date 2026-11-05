import { randomUUID } from "node:crypto";

import { SkladError } from "@/lib/kernel/errors";
import { readJsonFile, writeJsonFile } from "@/lib/kernel/json-file";
import { withLock } from "@/lib/kernel/lock";
import { pageOf } from "@/lib/kernel/page";
import type { JobKind, JobRecord, JobState, Page } from "@/lib/kernel/types";

const FILE = "jobs.json";

interface JobsFile {
  jobs: JobRecord[];
}

const ACTIVE: JobState[] = ["queued", "running", "paused"];

type Listener = (job: JobRecord) => void;
const listeners = new Set<Listener>();

export function subscribeJobs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(job: JobRecord): void {
  for (const listener of listeners) listener(job);
}

export function makeIdempotencyKey(input: { kind: string; hostId: string; source: string; destination: string }): string {
  return [input.kind, input.hostId, input.source, input.destination].join("\0");
}

export function engineControl(kind: JobKind): { pauseSupported: boolean; cancelSupported: boolean; pauseRefusal: string } {
  switch (kind) {
    case "compact":
      return {
        pauseSupported: false,
        cancelSupported: true,
        pauseRefusal: "compact.exe не умеет паузу. Можно отменить: файлы не удаляются.",
      };
    case "transcode":
      return {
        pauseSupported: false,
        cancelSupported: true,
        pauseRefusal: "HandBrakeCLI из Склада нельзя поставить на паузу. Отмена не удаляет исходник.",
      };
    case "delete-source":
      return {
        pauseSupported: false,
        cancelSupported: true,
        pauseRefusal: "Подтверждение удаления нельзя поставить на паузу. Отмена оставляет файлы на месте.",
      };
    default:
      return { pauseSupported: true, cancelSupported: true, pauseRefusal: "" };
  }
}

export function isActiveState(state: JobState): boolean {
  return ACTIVE.includes(state);
}

async function readAll(): Promise<JobRecord[]> {
  const file = await readJsonFile<JobsFile>(FILE);
  if (!file || !Array.isArray(file.jobs)) return [];
  return file.jobs;
}

async function writeAll(jobs: JobRecord[]): Promise<void> {
  await writeJsonFile(FILE, { jobs });
}

export async function listJobs(): Promise<JobRecord[]> {
  return withLock("jobs", readAll);
}

export async function jobsPage(offset: number, limit: number): Promise<Page<JobRecord>> {
  const jobs = await listJobs();
  const sorted = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt);
  return pageOf(sorted, offset, limit);
}

export async function getJob(id: string): Promise<JobRecord> {
  const jobs = await listJobs();
  const job = jobs.find((item) => item.id === id);
  if (!job) throw new SkladError("not_found", "Задание не найдено.");
  return job;
}

export interface NewJobInput {
  kind: JobKind;
  hostId: string;
  title: string;
  source: string;
  destination: string;
  totalBytes?: number;
  currentFile?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  message?: string;
}

export async function enqueueJob(input: NewJobInput): Promise<{ job: JobRecord; created: boolean }> {
  const source = input.source.trim();
  const destination = input.destination.trim();
  if (!input.hostId.trim() || !source || !destination) {
    throw new SkladError("validation", "Нужны хост, источник и назначение.");
  }
  const key = makeIdempotencyKey({ kind: input.kind, hostId: input.hostId, source, destination });
  const control = engineControl(input.kind);
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const existing = jobs.find((job) => job.idempotencyKey === key && isActiveState(job.state));
    if (existing) return { job: existing, created: false };
    const now = Date.now();
    const total = input.totalBytes && input.totalBytes > 0 ? input.totalBytes : 1;
    const job: JobRecord = {
      id: `job-${randomUUID()}`,
      kind: input.kind,
      hostId: input.hostId,
      title: input.title.trim() || input.kind,
      source,
      destination,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      claimToken: null,
      claimedBy: null,
      version: 1,
      idempotencyKey: key,
      pauseSupported: control.pauseSupported,
      cancelSupported: control.cancelSupported,
      pauseRefusal: control.pauseRefusal,
      message: input.message ?? "В очереди. Обработчик ещё не взял задание.",
      progress: {
        currentFile: input.currentFile || source,
        processedBytes: 0,
        totalBytes: total,
        speedBps: 0,
        etaSeconds: null,
        percent: 0,
      },
      payload: { sourceDeleted: false, ...(input.payload ?? {}) },
    };
    jobs.push(job);
    await writeAll(jobs);
    publish(job);
    return { job, created: true };
  });
}

/** Compare-and-set: only a queued job with an empty claim becomes running. */
export async function claimNext(agentId: string, hostId: string): Promise<JobRecord | null> {
  if (!agentId.trim()) throw new SkladError("validation", "Нужен идентификатор агента.");
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const job = jobs.find((item) => item.state === "queued" && item.hostId === hostId && !item.claimToken);
    if (!job) return null;
    const now = Date.now();
    job.state = "running";
    job.claimToken = randomUUID();
    job.claimedBy = agentId;
    job.startedAt = job.startedAt ?? now;
    job.updatedAt = now;
    job.attempts += 1;
    job.version += 1;
    job.message = `Выполняет ${agentId}.`;
    await writeAll(jobs);
    publish(job);
    return job;
  });
}

export async function compareAndSetJob(
  id: string,
  expectedVersion: number,
  patch: Partial<Pick<JobRecord, "state" | "message" | "claimToken" | "claimedBy" | "progress" | "payload">>,
): Promise<JobRecord | null> {
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const job = jobs.find((item) => item.id === id);
    if (!job || job.version !== expectedVersion) return null;
    if (patch.state) job.state = patch.state;
    if (patch.message !== undefined) job.message = patch.message;
    if (patch.claimToken !== undefined) job.claimToken = patch.claimToken;
    if (patch.claimedBy !== undefined) job.claimedBy = patch.claimedBy;
    if (patch.progress) job.progress = patch.progress;
    if (patch.payload) job.payload = { ...job.payload, ...patch.payload };
    job.version += 1;
    job.updatedAt = Date.now();
    if (job.state === "done" || job.state === "error") job.finishedAt = Date.now();
    await writeAll(jobs);
    publish(job);
    return job;
  });
}

export interface ProgressInput {
  id: string;
  claimToken: string;
  processedBytes: number;
  totalBytes: number;
  currentFile: string;
  speedBps: number;
  etaSeconds: number | null;
  message?: string;
  state?: JobState;
  payload?: Record<string, unknown>;
}

export async function reportProgress(input: ProgressInput): Promise<JobRecord> {
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const job = jobs.find((item) => item.id === input.id);
    if (!job) throw new SkladError("not_found", "Задание не найдено.");
    if (!job.claimToken || job.claimToken !== input.claimToken) {
      throw new SkladError("conflict", "Задание уже взято другим исполнителем.");
    }
    if (job.state !== "running" && job.state !== "paused") {
      throw new SkladError("conflict", "Задание уже завершено.");
    }
    const total = input.totalBytes > 0 ? input.totalBytes : job.progress.totalBytes;
    const processed = Math.max(0, Math.min(total, input.processedBytes));
    job.progress = {
      currentFile: input.currentFile || job.progress.currentFile,
      processedBytes: processed,
      totalBytes: total,
      speedBps: Math.max(0, input.speedBps),
      etaSeconds: input.etaSeconds,
      percent: total === 0 ? 0 : processed / total,
    };
    if (input.payload) job.payload = { ...job.payload, ...input.payload, sourceDeleted: job.payload.sourceDeleted === true };
    if (input.message) job.message = input.message;
    if (input.state === "paused" || input.state === "done" || input.state === "error" || input.state === "running") {
      job.state = input.state;
    }
    if (job.state === "done" || job.state === "error") {
      job.finishedAt = Date.now();
      job.claimToken = null;
    }
    job.version += 1;
    job.updatedAt = Date.now();
    await writeAll(jobs);
    publish(job);
    return job;
  });
}

export async function pauseJob(id: string): Promise<JobRecord> {
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const job = requireMutable(jobs, id);
    if (!job.pauseSupported) throw new SkladError("unavailable", job.pauseRefusal);
    if (job.state !== "running" && job.state !== "queued") {
      throw new SkladError("validation", "Пауза доступна для задания в очереди или в работе.");
    }
    job.state = "paused";
    job.message = "На паузе. Файлы пользователя не удалялись.";
    job.updatedAt = Date.now();
    job.version += 1;
    await writeAll(jobs);
    publish(job);
    return job;
  });
}

export async function resumeJob(id: string): Promise<JobRecord> {
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const job = requireMutable(jobs, id);
    if (job.state !== "paused") throw new SkladError("validation", "Продолжить можно только задание на паузе.");
    job.state = "queued";
    job.claimToken = null;
    job.claimedBy = null;
    job.message = "Снова в очереди.";
    job.updatedAt = Date.now();
    job.version += 1;
    await writeAll(jobs);
    publish(job);
    return job;
  });
}

export async function cancelJob(id: string): Promise<JobRecord> {
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const job = requireMutable(jobs, id);
    if (!job.cancelSupported) {
      throw new SkladError("unavailable", "Этот исполнитель не умеет отмену.");
    }
    if (job.state === "done") throw new SkladError("validation", "Задание уже завершено.");
    job.state = "error";
    job.claimToken = null;
    job.finishedAt = Date.now();
    job.message = "Отменено. Файлы пользователя не удалялись.";
    job.payload = { ...job.payload, sourceDeleted: false, cancelled: true };
    job.updatedAt = Date.now();
    job.version += 1;
    await writeAll(jobs);
    publish(job);
    return job;
  });
}

export async function retryJob(id: string): Promise<JobRecord> {
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const job = requireMutable(jobs, id);
    if (job.state !== "error") throw new SkladError("validation", "Повтор доступен после ошибки или отмены.");
    if (job.attempts >= job.maxAttempts) {
      throw new SkladError(
        "validation",
        `Попытки исчерпаны (${job.maxAttempts}). Источник не удалён, повтор не создаёт вторую копию сам.`,
      );
    }
    job.state = "queued";
    job.claimToken = null;
    job.claimedBy = null;
    job.finishedAt = null;
    job.message = "Повтор в очереди. Источник на месте.";
    job.payload = { ...job.payload, sourceDeleted: false, cancelled: false };
    job.updatedAt = Date.now();
    job.version += 1;
    await writeAll(jobs);
    publish(job);
    return job;
  });
}

export async function failJob(id: string, message: string): Promise<JobRecord> {
  return withLock("jobs", async () => {
    const jobs = await readAll();
    const job = requireMutable(jobs, id);
    job.state = "error";
    job.claimToken = null;
    job.finishedAt = Date.now();
    job.message = message;
    job.payload = { ...job.payload, sourceDeleted: false };
    job.updatedAt = Date.now();
    job.version += 1;
    await writeAll(jobs);
    publish(job);
    return job;
  });
}

function requireMutable(jobs: JobRecord[], id: string): JobRecord {
  const job = jobs.find((item) => item.id === id);
  if (!job) throw new SkladError("not_found", "Задание не найдено.");
  return job;
}

export async function replaceJobs(jobs: JobRecord[]): Promise<void> {
  await withLock("jobs", async () => {
    await writeAll(jobs);
  });
}
