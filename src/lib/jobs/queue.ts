import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { jobsFile } from "@/lib/app-data";
import { AppError } from "@/lib/app-error";
import { emptyProgress, type JobRecord, type JobState } from "@/lib/jobs/types";

type Handler = (job: JobRecord) => Promise<void>;

interface QueueRuntime {
  lockChain: Promise<void>;
  drainChain: Promise<void>;
  handlers: Map<string, Handler>;
  aborts: Map<string, AbortController>;
}

interface JobsFile {
  jobs: JobRecord[];
}

const ACTIVE: ReadonlySet<JobState> = new Set(["queued", "running", "paused"]);

function runtime(): QueueRuntime {
  const g = globalThis as { __skladJobQueue?: QueueRuntime };
  if (!g.__skladJobQueue) {
      g.__skladJobQueue = {
      lockChain: Promise.resolve(),
      drainChain: Promise.resolve(),
      handlers: new Map(),
      aborts: new Map(),
    };
  }
  return g.__skladJobQueue;
}

function lock<T>(fn: () => Promise<T>): Promise<T> {
  const state = runtime();
  const run = state.lockChain.then(fn, fn);
  state.lockChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function registerJobHandler(kind: string, handler: Handler): void {
  runtime().handlers.set(kind, handler);
}

export function bindJobAbort(id: string, controller: AbortController): void {
  runtime().aborts.set(id, controller);
}

export function unbindJobAbort(id: string): void {
  runtime().aborts.delete(id);
}

export function abortJob(id: string): void {
  runtime().aborts.get(id)?.abort();
}

export function whenJobsIdle(): Promise<void> {
  return runtime().drainChain;
}

export async function listJobs(): Promise<JobRecord[]> {
  const file = await readJobs();
  return file.jobs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const file = await readJobs();
  return file.jobs.find((job) => job.id === id) ?? null;
}

export async function enqueueJob<T>(input: {
  kind: string;
  idempotencyKey: string;
  title: string;
  payload: T;
  bytesTotal?: number;
  message?: string;
  onCreate?: () => void;
}): Promise<JobRecord<T>> {
  const created = await lock(async () => {
    const file = await readJobs();
    const existing = file.jobs.find((job) => job.idempotencyKey === input.idempotencyKey && ACTIVE.has(job.state));
    if (existing) return { job: existing as JobRecord<T>, duplicate: true };
    const now = Date.now();
    const job: JobRecord<T> = {
      id: `job-${randomUUID()}`,
      kind: input.kind,
      state: "queued",
      idempotencyKey: input.idempotencyKey,
      title: input.title,
      message: input.message ?? "В очереди",
      progress: emptyProgress(input.bytesTotal ?? 0),
      error: null,
      note: null,
      payload: input.payload,
      sessionId: null,
      control: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    file.jobs.push(job as JobRecord);
    await writeJobs(file);
    return { job, duplicate: false };
  });
  if (!created.duplicate) input.onCreate?.();
  kickQueue();
  return created.job;
}

export async function insertJob<T>(input: {
  kind: string;
  idempotencyKey: string;
  title: string;
  state: JobState;
  payload: T;
  bytesTotal?: number;
}): Promise<JobRecord<T>> {
  return lock(async () => {
    const file = await readJobs();
    const existing = file.jobs.find((job) => job.idempotencyKey === input.idempotencyKey && ACTIVE.has(job.state));
    if (existing) return existing as JobRecord<T>;
    const now = Date.now();
    const job: JobRecord<T> = {
      id: `job-${randomUUID()}`,
      kind: input.kind,
      state: input.state,
      idempotencyKey: input.idempotencyKey,
      title: input.title,
      message: "В очереди",
      progress: emptyProgress(input.bytesTotal ?? 0),
      error: null,
      note: null,
      payload: input.payload,
      sessionId: null,
      control: null,
      createdAt: now,
      updatedAt: now,
      startedAt: input.state === "running" ? now : null,
      finishedAt: null,
    };
    file.jobs.push(job as JobRecord);
    await writeJobs(file);
    return job;
  });
}

export async function updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord> {
  return lock(async () => {
    const file = await readJobs();
    const index = file.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new AppError(404, "Задача не найдена.");
    const next: JobRecord = {
      ...file.jobs[index],
      ...patch,
      id: file.jobs[index].id,
      kind: file.jobs[index].kind,
      idempotencyKey: file.jobs[index].idempotencyKey,
      createdAt: file.jobs[index].createdAt,
      updatedAt: Date.now(),
    };
    file.jobs[index] = next;
    await writeJobs(file);
    return next;
  });
}

export async function recoverInterruptedJobs(): Promise<void> {
  await lock(async () => {
    const file = await readJobs();
    let changed = false;
    for (const job of file.jobs) {
      if (job.state !== "running") continue;
      job.state = "error";
      job.error = "Передача прервана перезапуском Склада. По протоколу она не завершена.";
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      job.control = null;
      changed = true;
    }
    if (changed) await writeJobs(file);
  });
}

export async function controlJob(id: string, action: "pause" | "cancel" | "resume"): Promise<JobRecord> {
  const job = await getJob(id);
  if (!job) throw new AppError(404, "Задача не найдена.");
  if (action === "resume") {
    if (job.state !== "paused") throw new AppError(400, "Продолжить можно только задачу на паузе.");
    const next = await updateJob(id, { state: "queued", control: null, error: null, finishedAt: null });
    kickQueue();
    return next;
  }
  if (job.state === "done" || job.state === "error") {
    throw new AppError(400, "Задача уже завершена.");
  }
  if (job.state === "queued" || job.state === "paused") {
    return updateJob(id, {
      state: action === "pause" ? "paused" : "error",
      error: action === "pause" ? null : "Отменено до начала передачи. Маршрут cancel не вызывался.",
      finishedAt: action === "cancel" ? Date.now() : null,
      control: null,
    });
  }
  await updateJob(id, { control: action });
  abortJob(id);
  return (await getJob(id)) ?? job;
}

function kickQueue(): void {
  const state = runtime();
  state.drainChain = state.drainChain.then(drain, drain);
}

async function drain(): Promise<void> {
  for (;;) {
    const job = await claimNext();
    if (!job) return;
    const handler = runtime().handlers.get(job.kind);
    if (!handler) {
      await updateJob(job.id, {
        state: "error",
        error: `Нет обработчика для задачи ${job.kind}.`,
        finishedAt: Date.now(),
      });
      continue;
    }
    try {
      await handler(job);
    } catch (error) {
      const current = await getJob(job.id);
      if (current && current.state === "running") {
        await updateJob(job.id, {
          state: "error",
          error: error instanceof Error ? error.message : "Ошибка задачи.",
          finishedAt: Date.now(),
        });
      }
    }
  }
}

async function claimNext(): Promise<JobRecord | null> {
  return lock(async () => {
    const file = await readJobs();
    const next = file.jobs
      .filter((job) => job.state === "queued" && !isFileEngineJob(job))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return null;
    const now = Date.now();
    next.state = "running";
    next.startedAt = next.startedAt ?? now;
    next.updatedAt = now;
    next.error = null;
    await writeJobs(file);
    return next;
  });
}

async function readJobs(): Promise<JobsFile> {
  try {
    const text = await readFile(jobsFile(), "utf8");
    const parsed = JSON.parse(text) as { jobs?: unknown[] };
    if (!parsed || !Array.isArray(parsed.jobs)) return { jobs: [] };
    return { jobs: parsed.jobs.filter((job) => !isFileEngineJob(job)) as JobRecord[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [] };
    throw error;
  }
}

async function writeJobs(file: JobsFile): Promise<void> {
  const active = file.jobs.filter((job) => ACTIVE.has(job.state));
  const finished = file.jobs
    .filter((job) => !ACTIVE.has(job.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200);
  const target = jobsFile();
  const foreign = await foreignJobs(target, new Set(file.jobs.map((job) => job.id)));
  await mkdir(pathDir(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ jobs: [...foreign, ...active, ...finished] }, null, 2), { mode: 0o600 });
  await rename(tmp, target);
}

function isFileEngineJob(job: unknown): boolean {
  if (!job || typeof job !== "object") return false;
  const host = (job as { host?: string }).host;
  return host === "mac-local" || host === "pc-agent";
}

async function foreignJobs(file: string, ownIds: Set<string>): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { jobs?: unknown[] };
    if (!Array.isArray(parsed.jobs)) return [];
    return parsed.jobs.filter((job) => {
      if (!isFileEngineJob(job)) return false;
      const id = (job as { id?: string }).id;
      return typeof id !== "string" || !ownIds.has(id);
    });
  } catch {
    return [];
  }
}

function pathDir(file: string): string {
  const index = file.lastIndexOf("/");
  return index <= 0 ? "." : file.slice(0, index);
}
