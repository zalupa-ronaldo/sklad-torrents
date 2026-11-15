import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { getJob, mutateJobs, readJobs } from "@/lib/jobs/store";
import type { BackgroundJob } from "@/lib/jobs/types";
import {
  automaticPause,
  decideAdmission,
  hourInSchedule,
  shouldSuspendRunning,
  type AdmissionDecision,
  type PauseCause,
} from "@/lib/optical/admission";
import { OpticalError } from "@/lib/optical/errors";
import { dataDir } from "@/lib/qbittorrent/store";

export type ProcessPriority = "idle" | "below-normal" | "normal";

export interface OpticalLoad {
  queuePaused: boolean;
  disturb: boolean;
  maxParallel: number;
  schedule: { startHour: number; endHour: number } | null;
  processPriority: ProcessPriority;
}

const kicks = new Set<() => void>();
const live = new Set<string>();
let booted = false;
let clock: () => Date = () => new Date();

export function onOpticalQueueKick(fn: () => void): void {
  kicks.add(fn);
}

export function markOpticalLive(id: string): void {
  live.add(id);
}

export function clearOpticalLive(id: string): void {
  live.delete(id);
}

export function resetOpticalRuntimeForTests(): void {
  booted = false;
  live.clear();
  clock = () => new Date();
}

export function setOpticalClockForTests(next: () => Date): void {
  clock = next;
}

export function opticalNow(): Date {
  return clock();
}

function emptyLoad(): OpticalLoad {
  return {
    queuePaused: false,
    disturb: false,
    maxParallel: 1,
    schedule: null,
    processPriority: "below-normal",
  };
}

function asLoad(value: unknown, base: OpticalLoad): OpticalLoad {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const schedule = row.schedule;
  let parsedSchedule = base.schedule;
  if (schedule === null) parsedSchedule = null;
  else if (schedule && typeof schedule === "object") {
    const window = schedule as { startHour?: unknown; endHour?: unknown };
    const startHour = Number(window.startHour);
    const endHour = Number(window.endHour);
    if (Number.isFinite(startHour) && Number.isFinite(endHour)) parsedSchedule = { startHour, endHour };
  }
  const priority = row.processPriority;
  const processPriority: ProcessPriority =
    priority === "idle" || priority === "below-normal" || priority === "normal" ? priority : base.processPriority;
  const maxParallel = Number(row.maxParallel);
  return {
    queuePaused: row.queuePaused === true || base.queuePaused,
    disturb: row.disturb === true || base.disturb,
    maxParallel: Number.isFinite(maxParallel) ? maxParallel : base.maxParallel,
    schedule: parsedSchedule,
    processPriority,
  };
}

async function readJson(name: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path.join(dataDir(), name), "utf8")) as unknown;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function readOpticalLoad(): Promise<OpticalLoad> {
  const ownRaw = await readJson("optical-load.json");
  const externalRaw = await readJson("load-contract.json");
  const own = asLoad(ownRaw, emptyLoad());
  if (!externalRaw || typeof externalRaw !== "object") return own;
  const row = externalRaw as Record<string, unknown>;
  const external = asLoad(
    {
      queuePaused: row.queuePaused === true,
      disturb: row.disturb === true || row.busy === true,
      maxParallel: row.maxParallel,
      schedule: row.schedule,
      processPriority: row.processPriority,
    },
    emptyLoad(),
  );
  const localMax = ownRaw && typeof ownRaw === "object" ? finiteNumber((ownRaw as { maxParallel?: unknown }).maxParallel) : null;
  const externalMax = finiteNumber(row.maxParallel);
  const maxParallel =
    localMax !== null && externalMax !== null ? Math.min(localMax, externalMax) : (localMax ?? externalMax ?? 1);
  return {
    queuePaused: own.queuePaused || external.queuePaused,
    disturb: own.disturb || external.disturb,
    maxParallel,
    schedule: ownRaw && typeof ownRaw === "object" && "schedule" in (ownRaw as object) ? own.schedule : external.schedule,
    processPriority:
      ownRaw && typeof ownRaw === "object" && "processPriority" in (ownRaw as object)
        ? own.processPriority
        : external.processPriority,
  };
}

export async function writeOpticalLoad(patch: Partial<OpticalLoad>): Promise<OpticalLoad> {
  const current = asLoad(await readJson("optical-load.json"), emptyLoad());
  const next: OpticalLoad = {
    queuePaused: patch.queuePaused ?? current.queuePaused,
    disturb: patch.disturb ?? current.disturb,
    maxParallel: patch.maxParallel ?? current.maxParallel,
    schedule: patch.schedule === undefined ? current.schedule : patch.schedule,
    processPriority: patch.processPriority ?? current.processPriority,
  };
  const file = path.join(dataDir(), "optical-load.json");
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, file);
  return next;
}

export async function admissionFor(running: number): Promise<AdmissionDecision & { processPriority: ProcessPriority }> {
  const load = await readOpticalLoad();
  const decision = decideAdmission({
    queuePaused: load.queuePaused,
    disturb: load.disturb,
    maxParallel: load.maxParallel,
    running,
    withinSchedule: hourInSchedule(opticalNow().getUTCHours(), load.schedule),
  });
  return { ...decision, processPriority: load.processPriority };
}

export function isOpticalQueueJob(job: BackgroundJob): boolean {
  return job.kind.startsWith("optical.") || job.kind === "disc-image-studio";
}

export async function recoverOpticalAfterRestart(): Promise<number> {
  if (booted) return 0;
  booted = true;
  return mutateJobs((jobs) => {
    let changed = 0;
    for (const job of jobs) {
      if (!isOpticalQueueJob(job) || job.status !== "running" || live.has(job.id)) continue;
      job.status = "queued";
      job.claimedBy = null;
      changed += 1;
    }
    return changed;
  });
}

export async function opticalRunningCount(): Promise<number> {
  const jobs = await readJobs();
  return jobs.filter((job) => isOpticalQueueJob(job) && job.status === "running").length;
}

export async function reconcileOpticalLoad(): Promise<void> {
  const running = await opticalRunningCount();
  const decision = await admissionFor(Math.max(0, running - 1));
  if (shouldSuspendRunning(decision)) {
    await mutateJobs((jobs) => {
      for (const job of jobs) {
        if (!isOpticalQueueJob(job) || job.status !== "running") continue;
        if (pauseCause(job) === "user") continue;
        job.status = "paused";
        job.claimedBy = null;
        job.error = null;
        job.payload = { ...job.payload, pausedBy: decision.reason, processPriority: decision.processPriority };
      }
    });
    return;
  }
  const released = await mutateJobs((jobs) => {
    let count = 0;
    for (const job of jobs) {
      if (!isOpticalQueueJob(job) || job.status !== "paused") continue;
      if (!automaticPause(pauseCause(job))) continue;
      job.status = "queued";
      job.error = null;
      job.payload = { ...job.payload, pausedBy: null };
      count += 1;
    }
    return count;
  });
  if (released > 0) kickOpticalQueue();
}

function pauseCause(job: BackgroundJob): PauseCause | null {
  const value = job.payload.pausedBy;
  return value === "user" || value === "queue" || value === "disturb" || value === "schedule" ? value : null;
}

export async function pauseOpticalJob(id: string): Promise<BackgroundJob> {
  const job = await getJob(id);
  if (!job || !isOpticalQueueJob(job)) throw new OpticalError("not_found", "Задача не найдена.");
  if (job.status !== "queued" && job.status !== "running") {
    throw new OpticalError("validation", "Эту задачу уже нельзя поставить на паузу.");
  }
  const next = await mutateJobs((jobs) => {
    const found = jobs.find((item) => item.id === id);
    if (!found) return null;
    found.status = "paused";
    found.claimedBy = null;
    found.error = null;
    found.payload = { ...found.payload, pausedBy: "user" };
    return { ...found, payload: { ...found.payload } };
  });
  if (!next) throw new OpticalError("not_found", "Задача не найдена.");
  return next;
}

export async function resumeOpticalJob(id: string): Promise<BackgroundJob> {
  const job = await getJob(id);
  if (!job || !isOpticalQueueJob(job)) throw new OpticalError("not_found", "Задача не найдена.");
  if (job.status !== "paused") throw new OpticalError("validation", "Задача не на паузе.");
  const next = await mutateJobs((jobs) => {
    const found = jobs.find((item) => item.id === id);
    if (!found) return null;
    found.status = "queued";
    found.claimedBy = null;
    found.error = null;
    found.payload = { ...found.payload, pausedBy: null };
    return { ...found, payload: { ...found.payload } };
  });
  if (!next) throw new OpticalError("not_found", "Задача не найдена.");
  kickOpticalQueue();
  return next;
}

export async function cancelOpticalJob(id: string): Promise<BackgroundJob> {
  const job = await getJob(id);
  if (!job || !isOpticalQueueJob(job)) throw new OpticalError("not_found", "Задача не найдена.");
  if (job.status !== "queued" && job.status !== "running" && job.status !== "paused") {
    throw new OpticalError("validation", "Эту задачу уже нельзя отменить.");
  }
  const next = await mutateJobs((jobs) => {
    const found = jobs.find((item) => item.id === id);
    if (!found) return null;
    found.status = "error";
    found.claimedBy = null;
    found.hardware = false;
    found.error = "Отменено. Файлы на диске не удалялись.";
    found.payload = { ...found.payload, pausedBy: null, cancelled: true };
    return { ...found, payload: { ...found.payload } };
  });
  if (!next) throw new OpticalError("not_found", "Задача не найдена.");
  return next;
}

export async function controlOpticalFromPanel(id: string, action: "pause" | "resume" | "cancel"): Promise<BackgroundJob> {
  const raw = id.startsWith("optical__") ? id.slice("optical__".length) : id;
  if (action === "pause") return pauseOpticalJob(raw);
  if (action === "resume") return resumeOpticalJob(raw);
  return cancelOpticalJob(raw);
}

export async function pauseOpticalQueue(): Promise<void> {
  await writeOpticalLoad({ queuePaused: true });
  await reconcileOpticalLoad();
}

export async function resumeOpticalQueue(): Promise<void> {
  await writeOpticalLoad({ queuePaused: false });
  await reconcileOpticalLoad();
}

export function kickOpticalQueue(): void {
  for (const fn of kicks) fn();
}

export function stepIndexOf(job: BackgroundJob): number {
  const value = job.payload.stepIndex;
  return typeof value === "number" && value >= 0 ? value : 0;
}
