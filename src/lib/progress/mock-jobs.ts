import type { JobKind, JobSnapshot, JobStatus } from "@/lib/progress/types";

const PAUSE_UNSUPPORTED = "Движок не умеет паузу";

interface MockSeed {
  id: string;
  kind: JobKind;
  title: string;
  totalBytes: number;
  speed: number;
  files: string[];
  host: string | null;
  diskLabel: string | null;
  outputPath: string | null;
  canPause: boolean;
  canCancel: boolean;
  alreadyMs: number;
  status: JobStatus;
  error: string | null;
  processedBytes: number;
}

interface MockRuntime extends MockSeed {
  startedAt: number;
  pausedMs: number;
  pauseStartedAt: number | null;
  completedAt: number | null;
}

const SEEDS: MockSeed[] = [
  {
    id: "index-vault",
    kind: "index",
    title: "Индексация Vault",
    totalBytes: 80_000_000_000,
    speed: 400_000_000,
    files: ["Cinema/Interstellar.2014.2160p.mkv", "PSP/Games/God of War/ULUS10479.iso", "Music/NieR Automata OST"],
    host: "Mac mini",
    diskLabel: "Vault",
    outputPath: "/Volumes/vault",
    canPause: true,
    canCancel: true,
    alreadyMs: 30_000,
    status: "running",
    error: null,
    processedBytes: 0,
  },
  {
    id: "copy-control",
    kind: "copy",
    title: "Control Ultimate Edition — HDD → SSD",
    totalBytes: 14_000_000_000,
    speed: 70_000_000,
    files: ["Control_DX12.exe", "data/pack0.pack", "data/pack1.pack"],
    host: "Windows PC",
    diskLabel: "SSD",
    outputPath: "C:\\Games\\Control Ultimate Edition",
    canPause: true,
    canCancel: true,
    alreadyMs: 12_000,
    status: "running",
    error: null,
    processedBytes: 0,
  },
  {
    id: "compact-gow",
    kind: "compact",
    title: "CompactGUI — God of War (PSP)",
    totalBytes: 4_200_000_000,
    speed: 18_000_000,
    files: ["ISO/ULUS10479.iso", "ISO/ULES00157.iso", "Cover/front.jpg"],
    host: "Windows PC",
    diskLabel: "Игры",
    outputPath: "D:\\Games\\God of War (PSP)",
    canPause: false,
    canCancel: true,
    alreadyMs: 40_000,
    status: "running",
    error: null,
    processedBytes: 0,
  },
  {
    id: "transcode-interstellar",
    kind: "transcode",
    title: "HandBrake — Интерстеллар → 1080p",
    totalBytes: 8_000_000_000,
    speed: 20_000_000,
    files: ["Interstellar.2014.2160p.mkv"],
    host: "Mac mini",
    diskLabel: "Vault",
    outputPath: "/Volumes/vault/Cinema/Interstellar.2014.1080p.mkv",
    canPause: true,
    canCancel: true,
    alreadyMs: 8_000,
    status: "running",
    error: null,
    processedBytes: 0,
  },
  {
    id: "transcode-broken",
    kind: "transcode",
    title: "HandBrake — битый исходник",
    totalBytes: 2_000_000_000,
    speed: 0,
    files: ["holiday.mov"],
    host: "Mac mini",
    diskLabel: "Vault",
    outputPath: null,
    canPause: false,
    canCancel: false,
    alreadyMs: 0,
    status: "error",
    error: "HandBrake не открыл исходник",
    processedBytes: 360_000_000,
  },
];

const globalStore = globalThis as typeof globalThis & { __skladMockJobs?: MockRuntime[] };

export function resetMockJobsForTests(now = Date.now()): void {
  globalStore.__skladMockJobs = SEEDS.map((seed) => ({
    ...seed,
    files: [...seed.files],
    startedAt: now - seed.alreadyMs,
    pausedMs: 0,
    pauseStartedAt: null,
    completedAt: null,
  }));
}

export function listMockJobs(now = Date.now()): JobSnapshot[] {
  return runtime(now).map((job) => {
    sync(job, now);
    return snapshot(job, now);
  });
}

export function pauseMockJob(id: string, now = Date.now()): boolean {
  const job = runtime(now).find((item) => item.id === id);
  if (!job || !job.canPause || job.status !== "running") return false;
  sync(job, now);
  job.status = "paused";
  job.pauseStartedAt = now;
  return true;
}

export function resumeMockJob(id: string, now = Date.now()): boolean {
  const job = runtime(now).find((item) => item.id === id);
  if (!job || !job.canPause || job.status !== "paused") return false;
  if (job.pauseStartedAt !== null) {
    job.pausedMs += Math.max(0, now - job.pauseStartedAt);
    job.pauseStartedAt = null;
  }
  job.status = "running";
  sync(job, now);
  return true;
}

export function cancelMockJob(id: string, now = Date.now()): boolean {
  const job = runtime(now).find((item) => item.id === id);
  if (!job || !job.canCancel) return false;
  if (job.status === "completed" || job.status === "cancelled" || job.status === "error") return false;
  sync(job, now);
  job.status = "cancelled";
  job.pauseStartedAt = null;
  return true;
}

function runtime(now: number): MockRuntime[] {
  if (!globalStore.__skladMockJobs) resetMockJobsForTests(now);
  return globalStore.__skladMockJobs ?? [];
}

function sync(job: MockRuntime, now: number): void {
  if (job.status === "error" || job.status === "cancelled" || job.status === "paused" || job.status === "queued") return;
  if (job.status === "completed") {
    if (job.completedAt !== null && now - job.completedAt > 20_000) {
      job.status = "running";
      job.startedAt = now;
      job.pausedMs = 0;
      job.pauseStartedAt = null;
      job.completedAt = null;
      job.processedBytes = 0;
    }
    return;
  }
  const elapsed = Math.max(0, now - job.startedAt - job.pausedMs);
  const processed = Math.min(job.totalBytes, Math.floor((job.speed * elapsed) / 1000));
  job.processedBytes = processed;
  if (job.totalBytes > 0 && processed >= job.totalBytes) {
    job.status = "completed";
    job.completedAt = now;
    job.processedBytes = job.totalBytes;
  }
}

function snapshot(job: MockRuntime, now: number): JobSnapshot {
  const processed = job.processedBytes;
  const progress = job.totalBytes > 0 ? processed / job.totalBytes : 0;
  const moving = job.status === "running" && job.speed > 0;
  const remaining = Math.max(0, job.totalBytes - processed);
  const eta = moving ? remaining / job.speed : 8_640_000;
  const fileIndex = job.files.length === 0 ? 0 : Math.min(job.files.length - 1, Math.floor(progress * job.files.length));
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    progress,
    processedBytes: processed,
    totalBytes: job.totalBytes,
    speed: moving ? job.speed : 0,
    eta,
    currentFile: job.files[fileIndex] ?? null,
    host: job.host,
    diskLabel: job.diskLabel,
    outputPath: job.outputPath,
    error: job.error,
    capabilities: {
      pause: job.canPause && job.status === "running",
      resume: job.canPause && job.status === "paused",
      cancel: job.canCancel && (job.status === "running" || job.status === "paused" || job.status === "queued"),
    },
    pauseUnsupportedReason: job.canPause ? null : PAUSE_UNSUPPORTED,
    updatedAt: now,
  };
}
