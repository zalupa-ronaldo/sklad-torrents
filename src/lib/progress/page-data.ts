import { queueBoard, type QueueBoard } from "@/lib/progress/board";
import { getProgressPayload, type ProgressPayload } from "@/lib/progress/jobs";
import type { JobSnapshot } from "@/lib/progress/types";

export async function loadProgressPage(now = Date.now()): Promise<ProgressPayload & QueueBoard> {
  const payload = await getProgressPayload(now);
  const jobs = dedupeJobs(payload.jobs);
  const board = await queueBoard(jobs);
  return { ...payload, jobs, ...board };
}

/** The file store is listed by two adapters. Keep one card and the clearer title. */
function dedupeJobs(jobs: readonly JobSnapshot[]): JobSnapshot[] {
  const chosen = new Map<string, JobSnapshot>();
  for (const job of jobs) {
    const current = chosen.get(job.id);
    if (!current) {
      chosen.set(job.id, job);
      continue;
    }
    if (job.title.length > current.title.length) chosen.set(job.id, { ...current, title: job.title });
  }
  const seen = new Set<string>();
  const unique: JobSnapshot[] = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const picked = chosen.get(job.id);
    if (picked) unique.push(picked);
  }
  return unique;
}
