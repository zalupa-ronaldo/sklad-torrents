import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { JobError } from "@/lib/jobs/errors";
import {
  ACTIVE_JOB_STATES,
  JOB_HOSTS,
  JOB_KINDS,
  JOB_STATES,
  MAX_AUTO_RETRIES,
  type EnqueueInput,
  type Job,
  type JobCounts,
  type JobEvent,
  type JobHost,
  type JobKind,
  type JobList,
  type JobPayload,
  type JobProgress,
  type JobState,
  type PublicJob,
} from "@/lib/jobs/model";

interface StoredJob extends Job {
  seq: number;
}

const EMPTY_COUNTS: JobCounts = { queued: 0, running: 0, paused: 0, done: 0, error: 0 };

function emptyProgress(): JobProgress {
  return { percent: 0, processedBytes: 0, totalBytes: 0, speed: 0, etaSeconds: null, currentFile: "" };
}

export function toPublicJob(job: Job): PublicJob {
  return {
    id: job.id,
    kind: job.kind,
    host: job.host,
    state: job.state,
    payload: { ...job.payload },
    progress: { ...job.progress },
    attempts: job.attempts,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    idempotencyKey: job.idempotencyKey,
    verified: job.verified,
    autoRetries: job.autoRetries,
    cancelled: job.cancelled,
    sourceDeleted: job.sourceDeleted,
  };
}

export function jobIdempotencyKey(kind: JobKind, host: JobHost, source: string, destination: string): string {
  return [kind, host, normalizeOperand(host, source), normalizeOperand(host, destination)].join("\u0001");
}

function normalizeOperand(host: JobHost, value: string): string {
  const text = value.trim().replace(/[\u0000\u0001]/g, "");
  if (host === "pc-agent") return text.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
  return text.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function samePlace(host: JobHost, source: string, destination: string): boolean {
  const left = normalizeOperand(host, source);
  return left.length > 0 && left === normalizeOperand(host, destination);
}

function cloneJob(job: StoredJob): Job {
  const copy = toPublicJob(job);
  return { ...copy, payload: { ...copy.payload }, progress: { ...copy.progress }, workerToken: job.workerToken };
}

function countsOf(jobs: StoredJob[]): JobCounts {
  const counts: JobCounts = { ...EMPTY_COUNTS };
  for (const job of jobs) counts[job.state] += 1;
  return counts;
}

function isKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

function isHost(value: string): value is JobHost {
  return (JOB_HOSTS as readonly string[]).includes(value);
}

function isState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[\u0000\u0001]/g, "").slice(0, max);
}

function numberIn(value: unknown, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function parseStoredJob(value: unknown): StoredJob | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StoredJob>;
  if (typeof raw.id !== "string" || typeof raw.kind !== "string" || !isKind(raw.kind)) return null;
  if (typeof raw.host !== "string" || !isHost(raw.host)) return null;
  if (typeof raw.state !== "string" || !isState(raw.state)) return null;
  if (typeof raw.idempotencyKey !== "string" || typeof raw.createdAt !== "string") return null;
  const payload = raw.payload ?? {
    source: "",
    destination: "",
    diskId: "",
    torrentHash: "",
    handbrakeProfile: "",
    compactAlgorithm: "",
  };
  const progress = raw.progress ?? emptyProgress();
  return {
    id: raw.id,
    kind: raw.kind,
    host: raw.host,
    state: raw.state,
    payload: {
      source: cleanText(payload.source, 1024),
      destination: cleanText(payload.destination, 1024),
      diskId: cleanText(payload.diskId, 80),
      torrentHash: cleanText(payload.torrentHash, 64),
      handbrakeProfile: cleanText(payload.handbrakeProfile, 80),
      compactAlgorithm: cleanText(payload.compactAlgorithm, 40),
    },
    progress: {
      percent: numberIn(progress.percent, 0, 100),
      processedBytes: numberIn(progress.processedBytes, 0, Number.MAX_SAFE_INTEGER),
      totalBytes: numberIn(progress.totalBytes, 0, Number.MAX_SAFE_INTEGER),
      speed: numberIn(progress.speed, 0, Number.MAX_SAFE_INTEGER),
      etaSeconds:
        progress.etaSeconds === null || progress.etaSeconds === undefined ? null : numberIn(progress.etaSeconds, 0, 8_640_000),
      currentFile: cleanText(progress.currentFile, 240),
    },
    attempts: numberIn(raw.attempts, 0, 1_000_000),
    lastError: typeof raw.lastError === "string" ? raw.lastError.slice(0, 500) : null,
    createdAt: raw.createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : raw.createdAt,
    idempotencyKey: raw.idempotencyKey,
    verified: raw.verified === true,
    autoRetries: numberIn(raw.autoRetries, 0, 100),
    cancelled: raw.cancelled === true,
    sourceDeleted: raw.sourceDeleted === true,
    workerToken: typeof raw.workerToken === "string" ? raw.workerToken : null,
    seq: numberIn(raw.seq, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function validateEnqueue(input: EnqueueInput): JobPayload & { kind: JobKind; host: JobHost } {
  if (!isKind(input.kind)) throw new JobError("validation", "Неизвестный тип задачи.");
  if (!isHost(input.host)) throw new JobError("validation", "Неизвестный воркер.");
  const payload: JobPayload = {
    source: cleanText(input.source, 1024),
    destination: cleanText(input.destination, 1024),
    diskId: cleanText(input.diskId, 80),
    torrentHash: cleanText(input.torrentHash, 64),
    handbrakeProfile: cleanText(input.handbrakeProfile, 80),
    compactAlgorithm: cleanText(input.compactAlgorithm, 40),
  };
  if (payload.torrentHash && !/^[a-fA-F0-9]{32,64}$/.test(payload.torrentHash)) {
    throw new JobError("validation", "Хеш раздачи выглядит неверно.");
  }
  if ((input.kind === "move" || input.kind === "copy" || input.kind === "transcode") && (!payload.source || !payload.destination)) {
    throw new JobError("validation", "Нужны источник и назначение.");
  }
  if ((input.kind === "move" || input.kind === "copy" || input.kind === "transcode") && samePlace(input.host, payload.source, payload.destination)) {
    throw new JobError("validation", "Источник и назначение совпадают.");
  }
  if (input.kind === "index" && !payload.source && !payload.diskId) {
    throw new JobError("validation", "Для индекса нужен диск или каталог.");
  }
  if (input.kind === "index" && !payload.source) payload.source = payload.diskId;
  if (input.kind === "compact" && !payload.source) throw new JobError("validation", "Для сжатия нужен путь.");
  if (input.kind === "compact" && !payload.compactAlgorithm) throw new JobError("validation", "Укажите алгоритм сжатия.");
  if (input.kind === "transcode" && !payload.handbrakeProfile) throw new JobError("validation", "Укажите профиль HandBrake.");
  return { kind: input.kind, host: input.host, ...payload };
}

export interface EnqueueResult {
  job: Job;
  created: boolean;
}

export type ClaimResult = { ok: true; job: Job } | { ok: false; reason: "not_found" | "conflict"; job: Job | null };

export class JobStore {
  private jobs: StoredJob[] = [];
  private loaded = false;
  private chain: Promise<void> = Promise.resolve();
  private listeners = new Set<(event: JobEvent) => void>();
  private events: JobEvent[] = [];
  private seq = 0;
  readonly directory: string;
  readonly file: string;

  constructor(directory: string) {
    this.directory = directory;
    this.file = path.join(directory, "jobs.json");
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getEventLog(): JobEvent[] {
    return this.events.map((event) => structuredClone(event));
  }

  async enqueue(input: EnqueueInput, options?: { anyState?: boolean }): Promise<EnqueueResult> {
    const draft = validateEnqueue(input);
    return this.exclusive<EnqueueResult>(async () => {
      const key = jobIdempotencyKey(draft.kind, draft.host, draft.source, draft.destination);
      const existing = this.jobs.find((job) => job.idempotencyKey === key && (options?.anyState || ACTIVE_JOB_STATES.has(job.state)));
      if (existing) return { result: { job: cloneJob(existing), created: false }, dirty: false, events: [] };
      const now = new Date().toISOString();
      const job: StoredJob = {
        id: `job_${randomUUID()}`,
        kind: draft.kind,
        host: draft.host,
        state: "queued",
        payload: {
          source: draft.source,
          destination: draft.destination,
          diskId: draft.diskId,
          torrentHash: draft.torrentHash,
          handbrakeProfile: draft.handbrakeProfile,
          compactAlgorithm: draft.compactAlgorithm,
        },
        progress: emptyProgress(),
        attempts: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        idempotencyKey: key,
        verified: false,
        autoRetries: 0,
        cancelled: false,
        sourceDeleted: false,
        workerToken: null,
        seq: ++this.seq,
      };
      this.jobs.push(job);
      return { result: { job: cloneJob(job), created: true }, dirty: true, events: [this.upsertEvent(job)] };
    });
  }

  async get(id: string): Promise<Job | null> {
    return this.exclusive(async () => {
      const job = this.jobs.find((item) => item.id === id);
      return { result: job ? cloneJob(job) : null, dirty: false, events: [] };
    });
  }

  async list(query: { offset?: number; limit?: number; host?: JobHost; state?: JobState; q?: string } = {}): Promise<JobList> {
    return this.exclusive(async () => {
      const limit = clampLimit(query.limit);
      const filtered = this.filtered(query.host, query.state, query.q);
      const offset = clampOffset(query.offset, filtered.length);
      const slice = filtered.slice(offset, offset + limit);
      return {
        result: {
          jobs: slice.map(cloneJob),
          total: filtered.length,
          offset,
          limit,
          nextOffset: offset + slice.length < filtered.length ? offset + slice.length : null,
          counts: countsOf(this.jobs),
        },
        dirty: false,
        events: [],
      };
    });
  }

  async claim(id: string, host: JobHost): Promise<ClaimResult> {
    return this.exclusive<ClaimResult>(async () => {
      const job = this.jobs.find((item) => item.id === id);
      if (!job) return { result: { ok: false as const, reason: "not_found" as const, job: null }, dirty: false, events: [] };
      if (job.host !== host || job.state !== "queued") {
        return { result: { ok: false as const, reason: "conflict" as const, job: cloneJob(job) }, dirty: false, events: [] };
      }
      this.markRunning(job);
      return { result: { ok: true as const, job: cloneJob(job) }, dirty: true, events: [this.upsertEvent(job)] };
    });
  }

  async claimNext(host: JobHost, where?: (job: Job) => boolean): Promise<Job | null> {
    return this.exclusive(async () => {
      const job = this.jobs.filter((item) => item.host === host && item.state === "queued" && (where ? where(item) : true)).sort((a, b) => a.seq - b.seq)[0];
      if (!job) return { result: null, dirty: false, events: [] };
      this.markRunning(job);
      return { result: cloneJob(job), dirty: true, events: [this.upsertEvent(job)] };
    });
  }

  async updateProgress(id: string, token: string, progress: JobProgress): Promise<Job | null> {
    return this.exclusive(async () => {
      const job = this.ownedRunning(id, token);
      if (!job) return { result: null, dirty: false, events: [] };
      job.progress = {
        percent: numberIn(progress.percent, 0, 100),
        processedBytes: numberIn(progress.processedBytes, 0, Number.MAX_SAFE_INTEGER),
        totalBytes: numberIn(progress.totalBytes, 0, Number.MAX_SAFE_INTEGER),
        speed: numberIn(progress.speed, 0, Number.MAX_SAFE_INTEGER),
        etaSeconds: progress.etaSeconds === null ? null : numberIn(progress.etaSeconds, 0, 8_640_000),
        currentFile: cleanText(progress.currentFile, 240),
      };
      job.updatedAt = new Date().toISOString();
      const event: JobEvent = {
        type: "progress",
        job: toPublicJob(job),
        counts: countsOf(this.jobs),
        percent: job.progress.percent,
        processedBytes: job.progress.processedBytes,
        totalBytes: job.progress.totalBytes,
      };
      return { result: cloneJob(job), dirty: true, events: [event] };
    });
  }

  async markVerified(id: string, token: string): Promise<Job | null> {
    return this.exclusive(async () => {
      const job = this.ownedRunning(id, token);
      if (!job) return { result: null, dirty: false, events: [] };
      job.verified = true;
      job.updatedAt = new Date().toISOString();
      return { result: cloneJob(job), dirty: true, events: [this.upsertEvent(job)] };
    });
  }

  async complete(id: string, token: string): Promise<Job | null> {
    return this.exclusive(async () => {
      const job = this.ownedRunning(id, token);
      if (!job) return { result: null, dirty: false, events: [] };
      job.verified = true;
      job.state = "done";
      job.workerToken = null;
      job.progress = {
        ...job.progress,
        percent: 100,
        processedBytes: job.progress.totalBytes || job.progress.processedBytes,
        speed: 0,
        etaSeconds: 0,
      };
      job.updatedAt = new Date().toISOString();
      return { result: cloneJob(job), dirty: true, events: [this.upsertEvent(job)] };
    });
  }

  async fail(id: string, token: string, message: string): Promise<Job | null> {
    return this.exclusive(async () => {
      const job = this.jobs.find((item) => item.id === id);
      if (!job || job.workerToken !== token || job.state !== "running") return { result: null, dirty: false, events: [] };
      job.workerToken = null;
      job.lastError = cleanText(message, 500) || "Сбой задачи";
      job.updatedAt = new Date().toISOString();
      if (job.cancelled || job.verified || job.autoRetries >= MAX_AUTO_RETRIES) job.state = "error";
      else {
        job.autoRetries += 1;
        job.state = "queued";
      }
      return { result: cloneJob(job), dirty: true, events: [this.upsertEvent(job)] };
    });
  }

  async pause(id: string): Promise<Job> {
    return this.transition(id, (job) => {
      if (job.state !== "queued" && job.state !== "running") {
        throw new JobError("conflict", "Пауза доступна только для очереди и выполняющейся задачи.");
      }
      job.state = "paused";
      job.workerToken = null;
    });
  }

  async resume(id: string): Promise<Job> {
    return this.transition(id, (job) => {
      if (job.state !== "paused") throw new JobError("conflict", "Продолжить можно только задачу на паузе.");
      job.state = "queued";
      job.workerToken = null;
    });
  }

  async cancel(id: string): Promise<Job> {
    return this.transition(id, (job) => {
      if (job.state !== "queued" && job.state !== "running" && job.state !== "paused") {
        throw new JobError("conflict", "Эту задачу уже нельзя отменить.");
      }
      job.state = "error";
      job.cancelled = true;
      job.workerToken = null;
      job.lastError = "Отменено. Файлы на диске не удалялись.";
    });
  }

  async retry(id: string): Promise<Job> {
    return this.transition(id, (job) => {
      if (job.state !== "error") throw new JobError("conflict", "Повторить можно только задачу с ошибкой.");
      if (job.sourceDeleted) throw new JobError("conflict", "Исходник уже помечен удалённым, повтор не запускается.");
      job.state = "queued";
      job.cancelled = false;
      job.workerToken = null;
      job.verified = false;
      job.autoRetries = 0;
      job.progress = emptyProgress();
      job.lastError = null;
    });
  }

  async confirmDeleteSource(id: string): Promise<Job> {
    return this.transition(id, (job) => {
      if (job.kind !== "move" && job.kind !== "copy") {
        throw new JobError("validation", "Удаление исходника доступно после переноса или копирования.");
      }
      if (job.state !== "done" || !job.verified) throw new JobError("conflict", "Сначала дождитесь проверки результата.");
      job.sourceDeleted = true;
    });
  }

  async adoptOrphans(host: JobHost): Promise<number> {
    return this.exclusive(async () => {
      let changed = 0;
      const events: JobEvent[] = [];
      for (const job of this.jobs) {
        if (job.host !== host || job.state !== "running") continue;
        job.workerToken = null;
        job.updatedAt = new Date().toISOString();
        if (job.verified) {
          job.state = "done";
          job.progress = { ...job.progress, percent: 100, speed: 0, etaSeconds: 0 };
        } else job.state = "queued";
        changed += 1;
        events.push(this.upsertEvent(job));
      }
      return { result: changed, dirty: changed > 0, events };
    });
  }

  private markRunning(job: StoredJob) {
    job.state = "running";
    job.workerToken = randomUUID();
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    job.lastError = null;
  }

  private ownedRunning(id: string, token: string): StoredJob | null {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.state !== "running" || !token || job.workerToken !== token) return null;
    return job;
  }

  private async transition(id: string, apply: (job: StoredJob) => void): Promise<Job> {
    return this.exclusive(async () => {
      const job = this.jobs.find((item) => item.id === id);
      if (!job) throw new JobError("not_found", "Задача не найдена.");
      apply(job);
      job.updatedAt = new Date().toISOString();
      return { result: cloneJob(job), dirty: true, events: [this.upsertEvent(job)] };
    });
  }

  private filtered(host?: JobHost, state?: JobState, q?: string): StoredJob[] {
    const needle = q?.trim().toLowerCase() ?? "";
    return this.jobs
      .filter((job) => (host ? job.host === host : true))
      .filter((job) => (state ? job.state === state : true))
      .filter((job) => {
        if (!needle) return true;
        return [
          job.kind,
          job.host,
          job.payload.source,
          job.payload.destination,
          job.payload.diskId,
          job.payload.torrentHash,
          job.payload.handbrakeProfile,
          job.payload.compactAlgorithm,
          job.progress.currentFile,
          job.lastError ?? "",
        ]
          .join("\n")
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => b.seq - a.seq);
  }

  private upsertEvent(job: StoredJob): JobEvent {
    return { type: "upsert", job: toPublicJob(job), counts: countsOf(this.jobs) };
  }

  private async exclusive<T>(fn: () => Promise<{ result: T; dirty: boolean; events: JobEvent[] }>): Promise<T> {
    let result!: T;
    let events: JobEvent[] = [];
    await this.lock(async () => {
      const release = await acquireJobLock(this.directory);
      try {
        this.loaded = false;
        await this.ensureLoaded();
        const out = await fn();
        result = out.result;
        events = out.events;
        if (out.dirty) await this.persist();
      } finally {
        await release();
      }
    });
    for (const event of events) this.dispatch(event);
    return result;
  }

  private async lock(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private dispatch(event: JobEvent) {
    const copy = structuredClone(event);
    this.events.push(copy);
    if (this.events.length > 500) this.events.shift();
    for (const listener of this.listeners) listener(structuredClone(copy));
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const text = await readFile(this.file, "utf8");
      const parsed = JSON.parse(text) as { jobs?: unknown[] };
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs.map(parseStoredJob).filter((job): job is StoredJob => job !== null) : [];
      this.jobs = jobs;
      this.seq = jobs.reduce((max, job) => Math.max(max, job.seq), 0);
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.jobs = [];
        this.loaded = true;
        return;
      }
      throw new JobError("validation", "Не удалось прочитать очередь задач.");
    }
  }

  private async persist() {
    await mkdir(this.directory, { recursive: true });
    let foreign: unknown[] = [];
    try {
      const text = await readFile(this.file, "utf8");
      const parsed = JSON.parse(text) as { jobs?: unknown[] };
      if (Array.isArray(parsed.jobs)) foreign = parsed.jobs.filter((job) => parseStoredJob(job) === null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") foreign = [];
    }
    const tmp = path.join(this.directory, `.jobs.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify({ version: 1, jobs: [...foreign, ...this.jobs] }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

async function acquireJobLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const lockDir = path.join(directory, ".jobs.lock");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, "pid"), String(process.pid), { mode: 0o600 });
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(await readFile(path.join(lockDir, "pid"), "utf8").catch(() => "0"));
      if (!pidAlive(holder)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new JobError("conflict", "Очередь занята другим процессом.");
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | undefined, total: number): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(Math.floor(offset), total);
}

let singleton: JobStore | null = null;

export function createJobStore(directory: string): JobStore {
  return new JobStore(directory);
}

export function jobDataDir(): string {
  return process.env.SKLAD_DATA_DIR || path.join(process.cwd(), "data");
}

export function getJobStore(): JobStore {
  const directory = jobDataDir();
  if (!singleton || singleton.directory !== directory) singleton = createJobStore(directory);
  return singleton;
}

export function resetJobStoreForTests(): void {
  singleton = null;
}
