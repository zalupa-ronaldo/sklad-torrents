import { listJobs } from "@/lib/jobs/queue";
import type { JobRecord } from "@/lib/jobs/types";
import { registerJobSource } from "@/lib/progress/sources";
import type { JobSnapshot, JobStatus } from "@/lib/progress/types";

export function registerLocalsendProgress(): void {
  registerJobSource({
    id: "localsend",
    list: async () => {
      const jobs = await listJobs();
      return jobs.filter((job) => job.kind.startsWith("localsend.")).map(toSnapshot);
    },
  });
}

function toSnapshot(job: JobRecord): JobSnapshot {
  const total = job.progress.bytesTotal;
  const done = job.progress.bytesDone;
  const elapsed = job.startedAt && job.state === "running" ? (Date.now() - job.startedAt) / 1000 : 0;
  const speed = elapsed > 0.2 && done > 0 ? done / elapsed : 0;
  const hasSession = Boolean(job.sessionId);
  const status: JobStatus = job.state === "done" ? "completed" : job.state;
  return {
    id: `localsend__${job.id}`,
    kind: "localsend",
    title: job.title,
    status,
    progress: total > 0 ? Math.min(1, done / total) : job.state === "done" ? 1 : 0,
    processedBytes: done,
    totalBytes: total,
    speed,
    eta: speed > 0 ? Math.max(0, total - done) / speed : 8_640_000,
    currentFile: job.progress.fileName,
    host: "LocalSend",
    diskLabel: null,
    outputPath: null,
    error: job.error ?? job.note,
    capabilities: {
      pause: job.state === "running" && hasSession,
      resume: job.state === "paused",
      cancel: job.state === "queued" || job.state === "paused" || (job.state === "running" && hasSession),
    },
    pauseUnsupportedReason:
      job.state === "running" && !hasSession
        ? "Сессия ещё без sessionId, поэтому /api/localsend/v2/cancel вызывать рано."
        : null,
    updatedAt: job.updatedAt,
  };
}
