import { randomUUID } from "node:crypto";

import { dataFile, readJsonFile, writeJsonFile } from "@/lib/json-file";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { registerJobSource } from "@/lib/progress/sources";
import type { JobSnapshot } from "@/lib/progress/types";

export type PolicyJobKind = "handbrake" | "compact" | "index";

export interface PolicyJob {
  id: string;
  kind: PolicyJobKind;
  status: "queued" | "done";
  torrentName: string;
  hostId: string;
  hash: string;
  sourcePath: string;
  outputPath: string;
  deleteSource: boolean;
  createdAt: number;
  note: string;
}

interface JobsFile {
  jobs: PolicyJob[];
}

export async function loadPolicyJobs(): Promise<PolicyJob[]> {
  const file = await readJsonFile<JobsFile>(dataFile("content-policy-jobs.json"), { jobs: [] });
  if (!Array.isArray(file.jobs)) return [];
  return file.jobs.filter(isPolicyJob);
}

export async function enqueuePolicyJob(input: {
  kind: PolicyJobKind;
  torrentName: string;
  hostId: string;
  hash: string;
  sourcePath: string;
  outputPath: string;
  note: string;
}): Promise<PolicyJob> {
  const jobs = await loadPolicyJobs();
  const existing = jobs.find(
    (job) => job.kind === input.kind && job.hostId === input.hostId && job.hash === input.hash && job.outputPath === input.outputPath && job.status === "queued",
  );
  if (existing) return existing;
  const job: PolicyJob = {
    id: randomUUID(),
    kind: input.kind,
    status: "queued",
    torrentName: input.torrentName,
    hostId: input.hostId,
    hash: input.hash,
    sourcePath: input.sourcePath,
    outputPath: input.outputPath,
    deleteSource: false,
    createdAt: Date.now(),
    note: input.note,
  };
  jobs.push(job);
  await writeJsonFile(dataFile("content-policy-jobs.json"), { jobs });
  return job;
}

export async function confirmPolicyDelete(id: string, confirm: boolean): Promise<PolicyJob> {
  if (confirm !== true) {
    throw new QbittorrentError("validation", "Удаление исходника выключено. Нужно отдельное подтверждение.");
  }
  const jobs = await loadPolicyJobs();
  const job = jobs.find((item) => item.id === id);
  if (!job) throw new QbittorrentError("not_found", "Задание не найдено.");
  if (job.status !== "done") {
    throw new QbittorrentError(
      "validation",
      "Исходник не удаляется, пока нет отдельного проверенного результата. Включение автоматики это не делает.",
    );
  }
  job.deleteSource = true;
  job.note = "Удаление исходника подтверждено отдельно. Демо файлы на диске не стирает.";
  await writeJsonFile(dataFile("content-policy-jobs.json"), { jobs });
  return job;
}

export function policyJobsAsSnapshots(jobs: PolicyJob[]): JobSnapshot[] {
  return jobs
    .filter((job) => job.kind === "handbrake" || job.kind === "compact")
    .map((job) => ({
      id: `policy-${job.id}`,
      kind: job.kind === "handbrake" ? "transcode" : "compact",
      title: job.torrentName,
      status: "queued",
      progress: 0,
      processedBytes: 0,
      totalBytes: 0,
      speed: 0,
      eta: 8_640_000,
      currentFile: null,
      host: job.hostId,
      diskLabel: null,
      outputPath: job.outputPath,
      error: null,
      capabilities: { pause: false, resume: false, cancel: false },
      pauseUnsupportedReason: "Задание только поставлено в очередь. Исходник не трогается.",
      updatedAt: job.createdAt,
    }));
}

registerJobSource({
  id: "content-policy",
  async list() {
    return policyJobsAsSnapshots(await loadPolicyJobs());
  },
});

function isPolicyJob(value: unknown): value is PolicyJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<PolicyJob>;
  return typeof job.id === "string" && (job.kind === "handbrake" || job.kind === "compact" || job.kind === "index") && typeof job.outputPath === "string";
}
