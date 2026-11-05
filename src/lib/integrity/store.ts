import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/qbittorrent/store";
import type { IntegrityFile, IntegrityJob, TorrentHashRecord, VerifiedDiscRecord } from "@/lib/integrity/types";

let chain: Promise<unknown> = Promise.resolve();

function emptyFile(): IntegrityFile {
  return { version: 1, jobs: [], torrents: [], discs: [] };
}

function integrityPath(): string {
  return path.join(dataDir(), "integrity.json");
}

export async function readIntegrity(): Promise<IntegrityFile> {
  try {
    const text = await readFile(integrityPath(), "utf8");
    const parsed = JSON.parse(text) as Partial<IntegrityFile>;
    return {
      version: 1,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.filter(isJob) : [],
      torrents: Array.isArray(parsed.torrents) ? parsed.torrents.filter(isTorrent) : [],
      discs: Array.isArray(parsed.discs) ? parsed.discs.filter(isDisc) : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
    throw error;
  }
}

async function writeIntegrity(file: IntegrityFile): Promise<void> {
  const target = integrityPath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
  await rename(tmp, target);
}

export function mutateIntegrity<T>(fn: (file: IntegrityFile) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const file = await readIntegrity();
    const result = await fn(file);
    await writeIntegrity(file);
    return result;
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function resetIntegrityForTests(): Promise<void> {
  await mutateIntegrity((file) => {
    file.jobs = [];
    file.torrents = [];
    file.discs = [];
  });
}

function isJob(value: unknown): value is IntegrityJob {
  if (!value || typeof value !== "object") return false;
  const job = value as IntegrityJob;
  return typeof job.id === "string" && typeof job.kind === "string" && Array.isArray(job.files);
}

function isTorrent(value: unknown): value is TorrentHashRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as TorrentHashRecord;
  return typeof row.hostId === "string" && typeof row.hash === "string" && Array.isArray(row.files);
}

function isDisc(value: unknown): value is VerifiedDiscRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as VerifiedDiscRecord;
  return row.verified === true && row.erased === false && typeof row.jobId === "string";
}
