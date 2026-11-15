import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { dataDir } from "@/lib/qbittorrent/store";

export const COPY_PRIORITIES = ["background", "normal", "high"] as const;
export type CopyPriority = (typeof COPY_PRIORITIES)[number];

export interface CopySchedule {
  enabled: boolean;
  /** Local HH:MM, inclusive start. */
  start: string;
  /** Local HH:MM, exclusive end. Overnight windows wrap past midnight. */
  end: string;
}

export interface CopyLoadPolicy {
  version: 1;
  priority: CopyPriority;
  /** 1..3 copy or hash jobs at once. Quiet mode forces 1. */
  maxParallel: number;
  /** «Не мешать», when the person is playing or working. */
  quiet: boolean;
  schedule: CopySchedule;
  queuePaused: boolean;
}

export interface EffectiveCopyLoad {
  maxParallel: number;
  priority: CopyPriority;
  quiet: boolean;
  queuePaused: boolean;
  chunkDelayMs: number;
  bytesPerSecond: number;
  /** Hint for a dedicated agent process. The panel process is not reniced. */
  processNice: number;
  reniceProcess: false;
  reason: string;
}

const holders = new Set<string>();
let cached: { at: number; policy: CopyLoadPolicy } | null = null;

export function defaultCopyLoadPolicy(): CopyLoadPolicy {
  return {
    version: 1,
    priority: "normal",
    maxParallel: 2,
    quiet: false,
    schedule: { enabled: false, start: "09:00", end: "18:00" },
    queuePaused: false,
  };
}

export function effectiveCopyLoad(policy: CopyLoadPolicy, now: Date): EffectiveCopyLoad {
  if (policy.queuePaused) {
    return {
      maxParallel: 0,
      priority: "background",
      quiet: true,
      queuePaused: true,
      chunkDelayMs: 0,
      bytesPerSecond: 0,
      processNice: 10,
      reniceProcess: false,
      reason: "Очередь на паузе.",
    };
  }
  const scheduled = inQuietHours(policy.schedule, now);
  if (policy.quiet || scheduled) {
    return {
      maxParallel: 1,
      priority: "background",
      quiet: true,
      queuePaused: false,
      chunkDelayMs: 20,
      bytesPerSecond: 4 * 1024 * 1024,
      processNice: 10,
      reniceProcess: false,
      reason: policy.quiet ? "Режим «не мешать»." : "Тихие часы расписания.",
    };
  }
  const parallel = clampParallel(policy.maxParallel);
  if (policy.priority === "background") {
    return {
      maxParallel: 1,
      priority: "background",
      quiet: false,
      queuePaused: false,
      chunkDelayMs: 5,
      bytesPerSecond: 16 * 1024 * 1024,
      processNice: 10,
      reniceProcess: false,
      reason: "Фоновый приоритет.",
    };
  }
  if (policy.priority === "high") {
    return {
      maxParallel: parallel,
      priority: "high",
      quiet: false,
      queuePaused: false,
      chunkDelayMs: 0,
      bytesPerSecond: 0,
      processNice: 0,
      reniceProcess: false,
      reason: "Высокий приоритет копирования.",
    };
  }
  return {
    maxParallel: parallel,
    priority: "normal",
    quiet: false,
    queuePaused: false,
    chunkDelayMs: 0,
    bytesPerSecond: 0,
    processNice: 0,
    reniceProcess: false,
    reason: "Обычный приоритет.",
  };
}

export async function readCopyLoadPolicy(): Promise<CopyLoadPolicy> {
  try {
    const parsed = JSON.parse(await readFile(policyPath(), "utf8")) as Partial<CopyLoadPolicy>;
    return sanitizePolicy(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultCopyLoadPolicy();
    return defaultCopyLoadPolicy();
  }
}

export async function updateCopyLoadPolicy(patch: Partial<CopyLoadPolicy>): Promise<CopyLoadPolicy> {
  const current = await readCopyLoadPolicy();
  const next = sanitizePolicy({
    ...current,
    ...patch,
    schedule: { ...current.schedule, ...(patch.schedule ?? {}) },
  });
  const target = policyPath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, target);
  cached = null;
  return next;
}

export async function currentCopyLoad(now = new Date()): Promise<EffectiveCopyLoad> {
  if (!cached || Date.now() - cached.at > 500) {
    cached = { at: Date.now(), policy: await readCopyLoadPolicy() };
  }
  return effectiveCopyLoad(cached.policy, now);
}

export async function acquireCopySlot(id: string, shouldStop: () => boolean = () => false): Promise<boolean> {
  for (;;) {
    if (shouldStop()) return false;
    const load = await currentCopyLoad();
    if (!load.queuePaused && (holders.has(id) || holders.size < Math.max(1, load.maxParallel))) {
      holders.add(id);
      return true;
    }
    await delay(20);
  }
}

export function releaseCopySlot(id: string): void {
  holders.delete(id);
}

export function resetCopySlotsForTests(): void {
  holders.clear();
  cached = null;
}

function policyPath(): string {
  return path.join(dataDir(), "copy-load.json");
}

function sanitizePolicy(input: Partial<CopyLoadPolicy>): CopyLoadPolicy {
  const fallback = defaultCopyLoadPolicy();
  const priority = COPY_PRIORITIES.includes(input.priority as CopyPriority) ? (input.priority as CopyPriority) : fallback.priority;
  return {
    version: 1,
    priority,
    maxParallel: clampParallel(input.maxParallel ?? fallback.maxParallel),
    quiet: input.quiet === true,
    queuePaused: input.queuePaused === true,
    schedule: {
      enabled: input.schedule?.enabled === true,
      start: clock(input.schedule?.start, fallback.schedule.start),
      end: clock(input.schedule?.end, fallback.schedule.end),
    },
  };
}

function clampParallel(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(3, Math.floor(value)));
}

function clock(value: string | undefined, fallback: string): string {
  if (value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
  return fallback;
}

function inQuietHours(schedule: CopySchedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  const start = minutes(schedule.start);
  const end = minutes(schedule.end);
  if (start === null || end === null || start === end) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

function minutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
