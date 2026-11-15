import {
  controlIndex,
  defaultIndexPolicy,
  disksToIndexJobs,
  jobProgress,
  normalizeIndexPolicy,
  queueProgress,
  type IndexAction,
  type IndexJob,
  type IndexLoadPolicy,
} from "@/addons/drives/index-session";
import { readAgentConfig, readCatalog, writeCatalogChanges, liveDisks, setLiveDisks, type CatalogFile } from "@/addons/drives/store";
import type { DiskRecord } from "@/addons/drives/types";
import { DriveError } from "@/addons/drives/types";

export interface IndexBoard {
  policy: IndexLoadPolicy;
  queue: ReturnType<typeof queueProgress>;
  jobs: Array<ReturnType<typeof jobProgress> & { id: string; label: string; status: IndexJob["status"]; pauseReason: IndexJob["pauseReason"]; strategy: IndexJob["strategy"]; priority: number; checkpoint: IndexJob["checkpoint"] }>;
}

const policyState = ((globalThis as typeof globalThis & { __skladIndexPolicy?: IndexLoadPolicy }).__skladIndexPolicy ??= defaultIndexPolicy());

export function currentIndexPolicy(): IndexLoadPolicy {
  return policyState;
}

export function setIndexPolicy(input: unknown): IndexLoadPolicy {
  const next = normalizeIndexPolicy({ ...policyState, ...(input && typeof input === "object" ? input : {}) });
  Object.assign(policyState, next);
  policyState.quietHours = next.quietHours;
  return policyState;
}

export function boardFromDisks(disks: readonly DiskRecord[], policy = currentIndexPolicy()): IndexBoard {
  const jobs = disksToIndexJobs(disks);
  return {
    policy,
    queue: queueProgress(jobs),
    jobs: jobs.map((job) => ({
      id: job.id,
      label: job.label,
      status: job.status,
      pauseReason: job.pauseReason,
      strategy: job.strategy,
      priority: job.priority,
      checkpoint: job.checkpoint,
      ...jobProgress(job),
    })),
  };
}

export function withIndexAction(disks: readonly DiskRecord[], action: IndexAction, diskId: string | null, now = Date.now()): DiskRecord[] {
  const jobs = controlIndex(disksToIndexJobs(disks), diskId, action, now);
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return disks.map((disk) => {
    const job = byId.get(disk.id);
    if (!job) return disk;
    const progress = jobProgress(job);
    const status = job.status === "queued" ? "idle" : job.status === "cancelled" ? "error" : job.status;
    return {
      ...disk,
      scan: {
        ...disk.scan,
        status,
        progress: progress.progress,
        message: job.status === "cancelled"
          ? "Отменено. Файлы пользователя не удалялись."
          : job.status === "paused"
            ? "Индексация на паузе. Продолжение с места остановки."
            : job.status === "queued"
              ? "Снова в очереди. Продолжение с места остановки."
              : disk.scan.message,
        speed: progress.speed,
        eta: progress.eta,
        currentFile: progress.currentFile,
        processedBytes: progress.processedBytes,
        totalBytes: progress.totalBytes,
        pauseReason: job.pauseReason,
        checkpoint: job.checkpoint,
        priority: job.priority,
        updatedAt: now,
      },
    };
  });
}

export async function readIndexBoard(): Promise<IndexBoard> {
  const live = liveDisks();
  if (live) return boardFromDisks(live);
  const stored = await readCatalog();
  return boardFromDisks(stored?.disks ?? []);
}

export async function updateIndexControl(input: { action?: string; diskId?: string; policy?: unknown }, fetchImpl: typeof fetch = fetch): Promise<IndexBoard> {
  if (input.policy) setIndexPolicy(input.policy);
  const action = input.action;
  const known = liveDisks() ?? (await readCatalog())?.disks ?? [];
  let disks = known;
  if (action === "pause" || action === "resume" || action === "cancel" || action === "pause-all" || action === "resume-all" || action === "cancel-all") {
    if ((action === "pause" || action === "resume" || action === "cancel") && !input.diskId) {
      throw new DriveError(400, "Нужен диск. Индексация не менялась.");
    }
    disks = withIndexAction(known, action, input.diskId || null);
    const file: CatalogFile = { version: 1, seeded: true, disks };
    const previous = await readCatalog();
    await writeCatalogChanges(file, previous);
    setLiveDisks(disks);
    await forwardIndexAction(disks, action, input.diskId || null, fetchImpl);
  } else if (input.policy) {
    await forwardPolicy(fetchImpl);
  } else {
    throw new DriveError(400, "Нужно действие индексации.");
  }
  return boardFromDisks(disks);
}

async function forwardIndexAction(disks: readonly DiskRecord[], action: IndexAction, diskId: string | null, fetchImpl: typeof fetch): Promise<void> {
  const config = await readAgentConfig();
  if (config.mode !== "agents") return;
  const disk = diskId ? disks.find((item) => item.id === diskId) : null;
  await Promise.all(config.agents.map(async (agent) => {
    if (agent.os !== "win32") return;
    const body = action.endsWith("-all") || !disk
      ? { action }
      : { action, serial: disk.serial, uuid: disk.volumeUuid };
    try {
      await fetchImpl(`${agent.url.replace(/\/$/, "")}/v1/index/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      // The catalog already remembers the pause. The agent applies it on the next contact.
    }
  }));
}

async function forwardPolicy(fetchImpl: typeof fetch): Promise<void> {
  const config = await readAgentConfig();
  if (config.mode !== "agents") return;
  const policy = currentIndexPolicy();
  await Promise.all(config.agents.map(async (agent) => {
    if (agent.os !== "win32") return;
    try {
      await fetchImpl(`${agent.url.replace(/\/$/, "")}/v1/index/policy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policy),
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      // Local policy still applies to the panel.
    }
  }));
}
