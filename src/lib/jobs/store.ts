import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { publishJobs } from "@/lib/jobs/events";
import { ACTIVE_JOB, type BackgroundJob, type JobStatus } from "@/lib/jobs/types";
import { dataDir } from "@/lib/qbittorrent/store";

interface JobFile {
  version: 1;
  jobs: BackgroundJob[];
}

let chain: Promise<unknown> = Promise.resolve();

function jobsPath(): string {
  return path.join(dataDir(), "background-jobs.json");
}

function isJob(value: unknown): value is BackgroundJob {
  if (!value || typeof value !== "object") return false;
  const job = value as BackgroundJob;
  return typeof job.id === "string" && typeof job.kind === "string" && typeof job.status === "string";
}

export async function readJobs(): Promise<BackgroundJob[]> {
  try {
    const text = await readFile(jobsPath(), "utf8");
    const parsed = JSON.parse(text) as Partial<JobFile>;
    if (!parsed || !Array.isArray(parsed.jobs)) {
      throw new Error("Файл очереди задач имеет неизвестный формат. Склад его не перезаписывает.");
    }
    return parsed.jobs.filter(isJob);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeJobs(jobs: BackgroundJob[]): Promise<void> {
  const file = jobsPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body: JobFile = { version: 1, jobs };
  await writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
  await rename(tmp, file);
  publishJobs(jobs);
}

export function mutateJobs<T>(fn: (jobs: BackgroundJob[]) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const jobs = await readJobs();
    const result = await fn(jobs);
    await writeJobs(jobs);
    return result;
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function getJob(id: string): Promise<BackgroundJob | null> {
  const jobs = await readJobs();
  return jobs.find((job) => job.id === id) ?? null;
}

export async function insertIfIdle(job: BackgroundJob): Promise<BackgroundJob | null> {
  return mutateJobs((jobs) => {
    const duplicate = jobs.find(
      (item) => item.idempotencyKey === job.idempotencyKey && ACTIVE_JOB.has(item.status),
    );
    if (duplicate) return duplicate;
    jobs.push(job);
    return null;
  });
}

export async function claimNext(workerId: string, kinds: readonly string[]): Promise<BackgroundJob | null> {
  return mutateJobs((jobs) => {
    const job = jobs.find((item) => item.status === "queued" && kinds.includes(item.kind));
    if (!job) return null;
    job.status = "running";
    job.claimedBy = workerId;
    job.updatedAt = new Date().toISOString();
    return { ...job, payload: { ...job.payload } };
  });
}

export async function patchJob(
  id: string,
  patch: Partial<Omit<BackgroundJob, "payload">> & { payload?: Record<string, unknown> },
): Promise<BackgroundJob | null> {
  return mutateJobs((jobs) => {
    const job = jobs.find((item) => item.id === id);
    if (!job) return null;
    const { payload, ...rest } = patch;
    Object.assign(job, rest);
    if (payload) job.payload = { ...job.payload, ...payload };
    job.updatedAt = new Date().toISOString();
    return { ...job, payload: { ...job.payload } };
  });
}

export function jobIsActive(status: JobStatus): boolean {
  return ACTIVE_JOB.has(status);
}
