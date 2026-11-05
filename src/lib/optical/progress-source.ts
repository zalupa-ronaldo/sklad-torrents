import { readJobs } from "@/lib/jobs/store";
import type { BackgroundJob } from "@/lib/jobs/types";
import { registerJobSource } from "@/lib/progress/sources";
import type { JobSnapshot, JobStatus } from "@/lib/progress/types";

registerJobSource({
  id: "optical-dvd",
  async list() {
    const jobs = await readJobs();
    return jobs.filter((job) => job.kind.startsWith("optical.")).map(toSnapshot);
  },
});

function toSnapshot(job: BackgroundJob): JobSnapshot {
  const status = mapStatus(job.status);
  const phase = job.phase && job.phase !== "ожидание" ? job.phase : "";
  const file = job.currentFile || "";
  const currentFile = [phase, file].filter(Boolean).join(" · ") || null;
  return {
    id: `optical__${job.id}`,
    kind: "optical",
    title: job.mock ? `Демо · ${job.title}` : job.title,
    status,
    progress: Math.min(1, Math.max(0, job.percent / 100)),
    processedBytes: job.bytesDone ?? 0,
    totalBytes: job.bytesTotal ?? 0,
    speed: 0,
    eta: 8_640_000,
    currentFile,
    host: job.mock ? "демо" : null,
    diskLabel: job.mock ? "демо, не настоящий диск" : null,
    outputPath: typeof job.payload.isoPath === "string" ? job.payload.isoPath : null,
    error: job.error,
    capabilities: { pause: false, resume: false, cancel: false },
    pauseUnsupportedReason: job.mock
      ? "Это демо. Команды записаны, привод ничего не писал."
      : "Пауза этой записи не поддерживается.",
    updatedAt: Date.parse(job.updatedAt) || Date.now(),
  };
}

function mapStatus(status: BackgroundJob["status"]): JobStatus {
  if (status === "done") return "completed";
  if (status === "error") return "error";
  if (status === "paused") return "paused";
  if (status === "running") return "running";
  return "queued";
}
