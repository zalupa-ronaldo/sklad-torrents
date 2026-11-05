import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OpticalJob } from "@/lib/optical/types";

interface JobsFile {
  jobs: OpticalJob[];
}

interface AgentFile {
  baseUrl?: string | null;
}

export function opticalDataDir(): string {
  return process.env.SKLAD_DATA_DIR || path.join(process.cwd(), "data");
}

function jobsPath(): string {
  return path.join(opticalDataDir(), "optical-jobs.json");
}

function agentPath(): string {
  return path.join(opticalDataDir(), "optical-agent.json");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

export async function readJobs(): Promise<OpticalJob[]> {
  const file = await readJson<JobsFile>(jobsPath(), { jobs: [] });
  return Array.isArray(file.jobs) ? file.jobs : [];
}

export async function writeJobs(jobs: OpticalJob[]): Promise<void> {
  await writeJson(jobsPath(), { jobs: jobs.slice(-100) });
}

export async function upsertJob(job: OpticalJob): Promise<void> {
  const jobs = await readJobs();
  const next = jobs.filter((item) => item.id !== job.id);
  next.push(job);
  await writeJobs(next);
}

export async function readStoredAgentUrl(): Promise<string | null> {
  const file = await readJson<AgentFile>(agentPath(), {});
  const value = typeof file.baseUrl === "string" ? file.baseUrl.trim() : "";
  return value || null;
}

export async function writeStoredAgentUrl(baseUrl: string | null): Promise<void> {
  await writeJson(agentPath(), { baseUrl });
}
