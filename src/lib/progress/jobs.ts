import "@/lib/policies/jobs";
import "@/lib/optical/jobs";
import "@/lib/optical/progress-source";
import "@/lib/integrity/progress-source";
import "@/lib/progress/engine-jobs";
import "@/lib/jobs/register-source";
import type { CatalogDisk } from "@/lib/drives/types";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { pauseTorrent } from "@/lib/qbittorrent/service";
import type { TorrentView } from "@/lib/qbittorrent/types";
import { performKernelAction } from "@/lib/progress/engine-jobs";
import { parseJobId } from "@/lib/progress/ids";
import { cancelMockJob, listMockJobs, pauseMockJob, resumeMockJob } from "@/lib/progress/mock-jobs";
import { listRegisteredJobs } from "@/lib/progress/sources";
import type { JobSnapshot, JobStatus } from "@/lib/progress/types";
import { resumeRespectingDisk, tickScheduler, type SchedulerTick } from "@/lib/scheduler/apply";
import { resolveDisk } from "@/lib/scheduler/disk-key";
import type { DiskQueueView } from "@/lib/scheduler/types";

const PAUSE_UNSUPPORTED = "Движок не умеет паузу";

export interface ProgressPayload {
  jobs: JobSnapshot[];
  queues: DiskQueueView[];
  fetchedAt: number;
}

export async function getProgressPayload(now = Date.now()): Promise<ProgressPayload> {
  await registerLocalsendJobs();
  const tick = await tickScheduler();
  const jobs = await collectJobs(tick, now);
  return { jobs, queues: tick.plan.queues, fetchedAt: now };
}

async function registerLocalsendJobs(): Promise<void> {
  try {
    const { registerLocalsendProgress } = await import("@/lib/localsend/progress");
    registerLocalsendProgress();
  } catch {
    // The progress page still lists the other engines if LocalSend failed to load.
  }
}

export async function getJob(id: string, now = Date.now()): Promise<JobSnapshot | null> {
  const payload = await getProgressPayload(now);
  const parsed = parseJobId(id);
  return payload.jobs.find((job) => job.id === parsedId(parsed)) ?? null;
}

export async function performJobAction(
  id: string,
  action: "pause" | "resume" | "cancel",
  now = Date.now(),
): Promise<{ notice?: string }> {
  if (id.startsWith("hash-")) {
    if (action !== "cancel") {
      throw new QbittorrentError("validation", "Пауза подсчёта — это отмена. Уже посчитанные хэши остаются, файлы не удаляются.");
    }
    const { cancelIntegrity } = await import("@/lib/integrity/engine");
    await cancelIntegrity(id);
    return { notice: "Подсчёт SHA-256 остановлен. Файлы не удалялись." };
  }
  if (id.startsWith("localsend__")) {
    const { controlJob } = await import("@/lib/jobs/queue");
    await controlJob(id.slice("localsend__".length), action);
    return action === "cancel" ? { notice: "Остановка LocalSend запрошена. Файл не удаляется." } : {};
  }
  const parsed = parseJobId(id);
  if (parsed.kind === "local" && parsed.id.startsWith("kernel__")) {
    return performKernelAction(parsed.id.slice("kernel__".length), action);
  }
  if (parsed.kind === "local" && parsed.id.startsWith("job_")) return fileQueueAction(parsed.id, action);
  if (parsed.kind === "local") return performMockAction(parsed.id, action, now);
  if (action === "cancel") {
    throw new QbittorrentError("validation", "Отмена раздачи не удаляет файлы отсюда. Удалите её в списке, если нужно.");
  }
  if (action === "pause") {
    await pauseTorrent(parsed.hostId, parsed.hash, { user: true });
    const tick = await tickScheduler();
    return tick.applied.resume.length > 0
      ? { notice: "На паузе. Следующая загрузка на этом диске запущена." }
      : {};
  }
  return resumeRespectingDisk(parsed.hostId, parsed.hash);
}

async function fileQueueAction(id: string, action: "pause" | "resume" | "cancel"): Promise<{ notice?: string }> {
  const { JobError } = await import("@/lib/jobs/errors");
  const { getJobStore } = await import("@/lib/jobs/engine");
  try {
    const store = getJobStore();
    if (action === "pause") await store.pause(id);
    else if (action === "resume") await store.resume(id);
    else await store.cancel(id);
  } catch (error) {
    if (error instanceof JobError) {
      throw new QbittorrentError(error.code === "not_found" ? "not_found" : "validation", error.message);
    }
    throw error;
  }
  return action === "cancel" ? { notice: "Отменено. Файлы на диске не удалялись." } : {};
}

async function performMockAction(id: string, action: "pause" | "resume" | "cancel", now: number): Promise<{ notice?: string }> {
  if (!listMockJobs(now).some((job) => job.id === id)) {
    throw new QbittorrentError("not_found", "Операция не найдена.");
  }
  if (action === "pause") {
    if (!pauseMockJob(id, now)) throw new QbittorrentError("validation", PAUSE_UNSUPPORTED);
    return {};
  }
  if (action === "resume") {
    if (!resumeMockJob(id, now)) throw new QbittorrentError("validation", "Эту операцию нельзя продолжить.");
    return {};
  }
  if (!cancelMockJob(id, now)) throw new QbittorrentError("validation", "Эту операцию нельзя отменить.");
  return { notice: "Остановлено. Файлы на диске не удалялись." };
}

export async function collectJobs(tick: SchedulerTick, now: number): Promise<JobSnapshot[]> {
  const extra = await listRegisteredJobs();
  const realOnly = process.env.SKLAD_REAL_ONLY === "1";
  const mocks = realOnly
    ? []
    : listMockJobs(now).filter((job) => job.id === "transcode-broken" || !coveredByEngine(job, extra));
  const jobs = [...mocks, ...torrentJobs(tick.dashboard.torrents, tick.catalog, now), ...extra]
    .filter((job) => {
      if (!realOnly) return true;
      const id = String(job.id || "");
      const host = String(job.host || "").toLowerCase();
      if (id.includes("demo") || id.startsWith("kernel__job-demo")) return false;
      if (host.includes("demo")) return false;
      return true;
    })
    .filter((job) => job && typeof job.id === "string")
    .map((job) => ({
      ...job,
      title: job.title || "Операция",
      status: job.status || "running",
    }));
  jobs.sort(compareJobs);
  return jobs;
}

function coveredByEngine(mock: JobSnapshot, extra: JobSnapshot[]): boolean {
  return extra.some(
    (job) => job.kind === mock.kind && (job.status === "running" || job.status === "paused") && job.processedBytes > 0,
  );
}

function torrentJobs(torrents: TorrentView[], catalog: CatalogDisk[], now: number): JobSnapshot[] {
  return torrents.filter((torrent) => torrent.state !== "unknown").map((torrent) => toTorrentJob(torrent, catalog, now));
}

function toTorrentJob(torrent: TorrentView, catalog: CatalogDisk[], now: number): JobSnapshot {
  const disk = resolveDisk({
    hostId: torrent.hostId,
    hostOs: torrent.hostOs,
    savePath: torrent.savePath,
    catalog,
  });
  const seeding = torrent.state === "seeding" || torrent.rawState.endsWith("UP");
  const status = torrentStatus(torrent);
  const running = status === "running";
  return {
    id: `torrent__${torrent.hostId}__${torrent.hash}`,
    kind: "torrent",
    title: torrent.name,
    status,
    progress: torrent.progress,
    processedBytes: torrent.downloaded,
    totalBytes: torrent.size || torrent.totalSize,
    speed: running ? (seeding ? torrent.upspeed : torrent.dlspeed) : 0,
    eta: torrent.eta,
    currentFile: baseName(torrent.contentPath || torrent.savePath),
    host: torrent.hostName,
    diskLabel: disk.label,
    outputPath: torrent.contentPath || torrent.savePath,
    error: torrentError(torrent),
    capabilities: {
      pause: running,
      resume: status === "paused" || status === "queued",
      cancel: false,
    },
    pauseUnsupportedReason: null,
    updatedAt: now,
  };
}

function torrentStatus(torrent: TorrentView): JobStatus {
  if (torrent.state === "error" || torrent.state === "missing") return "error";
  if (torrent.state === "paused") return "paused";
  if (torrent.state === "queued") return "queued";
  if (torrent.progress >= 0.999 && torrent.state !== "seeding" && torrent.state !== "checking" && torrent.state !== "moving") {
    return "completed";
  }
  return "running";
}

function torrentError(torrent: TorrentView): string | null {
  if (torrent.state === "missing") return "Файлы не найдены на диске";
  if (torrent.state === "error") return "Ошибка qBittorrent";
  return null;
}

function compareJobs(a: JobSnapshot, b: JobSnapshot): number {
  const rank: Record<JobStatus, number> = { error: 0, running: 1, paused: 2, queued: 3, cancelled: 4, completed: 5 };
  const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  if (byStatus !== 0) return byStatus;
  return String(a.title ?? "").localeCompare(String(b.title ?? ""), "ru");
}

function baseName(value: string): string | null {
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function parsedId(parsed: ReturnType<typeof parseJobId>): string {
  return parsed.kind === "torrent" ? `torrent__${parsed.hostId}__${parsed.hash}` : parsed.id;
}
