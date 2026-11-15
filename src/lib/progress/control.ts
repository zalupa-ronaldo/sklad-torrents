import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { localJobHost } from "@/lib/jobs/local-host";
import type { JobHost } from "@/lib/jobs/model";

import { isChannelDetail, parseLinkStatus, type LinkStatus } from "@/lib/progress/channel";
import { isIgnoredVolume } from "@/lib/progress/paths";

export type ProcessPriority = "idle" | "below-normal" | "normal";
export type QueueScope = "all" | "mac-local" | "pc-agent";

export interface QuietHour {
  startHour: number;
  endHour: number;
}

export interface LoadPolicy {
  maxParallel: Record<JobHost, number>;
  handbrakeSlots: { "mac-local": number; "pc-agent": number };
  /** idle | below-normal | normal. `below` from the disk index is stored as below-normal. */
  processPriority: ProcessPriority;
  /** «Не мешать, когда я играю или работаю». */
  quiet: boolean;
  /** Hours when new work waits. Empty means the clock does not block. A window may cross midnight. */
  quietHours: QuietHour[];
  yieldWhileActive: boolean;
  userActive: { "mac-local": boolean; "pc-agent": boolean };
  schedule: { enabled: boolean; startMinute: number; endMinute: number };
}

export interface QueueControl {
  version: 1;
  paused: boolean;
  hosts: Record<JobHost, { paused: boolean }>;
  /** Jobs this queue paused. A task the user paused earlier is not in this list. */
  pausedByQueue: string[];
  /** HandBrake and CompactGUI paused because the machine is in use. */
  pausedByYield: string[];
  load: LoadPolicy;
  updatedAt: string;
}

export interface AdmissionJob {
  kind: string;
  host: string;
  lastError: string | null;
  payload: { source: string; destination: string };
}

export type AdmissionDecision = { ok: true } | { ok: false; detail: string };

let cache: { dir: string; control: QueueControl } | null = null;
let linkOverride: LinkStatus | null = null;
let linkOverrideSet = false;
let clock: () => number = () => Date.now();

export function defaultControl(now = new Date().toISOString()): QueueControl {
  return {
    version: 1,
    paused: false,
    hosts: {
      "mac-local": { paused: false },
      "pc-agent": { paused: false },
      "linux-local": { paused: false },
    },
    pausedByQueue: [],
    pausedByYield: [],
    load: {
      maxParallel: { "mac-local": 2, "pc-agent": 2, "linux-local": 2 },
      handbrakeSlots: { "mac-local": 1, "pc-agent": 1 },
      processPriority: "below-normal",
      quiet: false,
      quietHours: [],
      yieldWhileActive: false,
      userActive: { "mac-local": false, "pc-agent": false },
      schedule: { enabled: false, startMinute: 60, endMinute: 480 },
    },
    updatedAt: now,
  };
}

/** Same directory as the job store. Duplicated so this module does not import the store while the store binds us. */
export function queueDataDir(): string {
  return process.env.SKLAD_DATA_DIR || path.join(process.cwd(), "data");
}

export function setQueueClock(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

export function minuteNow(): number {
  const date = new Date(clock());
  return date.getHours() * 60 + date.getMinutes();
}

export function resetQueueControlForTests(): void {
  cache = null;
  linkOverride = null;
  linkOverrideSet = false;
  clock = () => Date.now();
}

/**
 * Remember the channel snapshot for admission.
 * This never resumes a paused task and never clears a user pause.
 */
export function observeLink(status: LinkStatus | null): void {
  linkOverride = status;
  linkOverrideSet = true;
}

export async function currentLink(): Promise<LinkStatus | null> {
  if (linkOverrideSet) return linkOverride;
  return readLinkFile(queueDataDir());
}

export async function readControl(): Promise<QueueControl> {
  const dir = queueDataDir();
  if (cache?.dir === dir) return structuredClone(cache.control);
  const control = await load(dir);
  if (cache?.dir === dir) return structuredClone(cache.control);
  cache = { dir, control };
  return structuredClone(control);
}

export async function writeControl(control: QueueControl): Promise<void> {
  const dir = queueDataDir();
  const next = sanitize(control);
  next.updatedAt = new Date().toISOString();
  cache = { dir, control: structuredClone(next) };
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.queue-control.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, path.join(dir, "queue-control.json"));
  const contract = toLoadContract(next);
  const contractTmp = path.join(dir, `.load-contract.${process.pid}.tmp`);
  await writeFile(contractTmp, JSON.stringify(contract, null, 2), { mode: 0o600 });
  await rename(contractTmp, path.join(dir, "load-contract.json"));
}

/** File the optical, index, and copy queues read. Mac and PC limits stay separate. */
export function toLoadContract(control: QueueControl): Record<string, unknown> {
  const load = control.load;
  return {
    queuePaused: control.paused,
    disturb: load.quiet,
    quiet: load.quiet,
    processPriority: load.processPriority,
    maxParallel: load.maxParallel["pc-agent"],
    mac: { maxParallel: load.maxParallel["mac-local"], handbrakeSlots: load.handbrakeSlots["mac-local"] },
    pc: { maxParallel: load.maxParallel["pc-agent"], handbrakeSlots: load.handbrakeSlots["pc-agent"] },
    schedule: load.schedule.enabled
      ? { startHour: Math.floor(load.schedule.startMinute / 60), endHour: Math.floor(load.schedule.endMinute / 60) }
      : null,
    quietHours: load.quietHours,
  };
}

export function sanitizeLoad(value: unknown, fallback: LoadPolicy = defaultControl().load): LoadPolicy {
  const raw = value && typeof value === "object" ? (value as Partial<LoadPolicy> & Record<string, unknown>) : {};
  const nested = raw as { mac?: { maxParallel?: unknown; handbrakeSlots?: unknown }; pc?: { maxParallel?: unknown; handbrakeSlots?: unknown } };
  const parallel: Partial<Record<JobHost, number>> = { ...(raw.maxParallel ?? {}) };
  if (nested.mac?.maxParallel !== undefined) parallel["mac-local"] = numberOr(nested.mac.maxParallel, parallel["mac-local"]);
  if (nested.pc?.maxParallel !== undefined) parallel["pc-agent"] = numberOr(nested.pc.maxParallel, parallel["pc-agent"]);
  const slots = { ...(raw.handbrakeSlots ?? { "mac-local": fallback.handbrakeSlots["mac-local"], "pc-agent": fallback.handbrakeSlots["pc-agent"] }) };
  if (nested.mac?.handbrakeSlots !== undefined) slots["mac-local"] = numberOr(nested.mac.handbrakeSlots, slots["mac-local"]);
  if (nested.pc?.handbrakeSlots !== undefined) slots["pc-agent"] = numberOr(nested.pc.handbrakeSlots, slots["pc-agent"]);
  const active = raw.userActive ?? fallback.userActive;
  const schedule = raw.schedule ?? fallback.schedule;
  const quietFlags = [raw.quiet, raw.yieldWhileActive, raw.disturb].filter((value) => value !== undefined);
  const quiet = quietFlags.length > 0 ? quietFlags.some((value) => value === true) : fallback.quiet;
  return {
    maxParallel: {
      "mac-local": clampInt(parallel["mac-local"], 1, 8, fallback.maxParallel["mac-local"]),
      "pc-agent": clampInt(parallel["pc-agent"], 1, 8, fallback.maxParallel["pc-agent"]),
      "linux-local": clampInt(parallel["linux-local"], 1, 8, fallback.maxParallel["linux-local"]),
    },
    handbrakeSlots: {
      "mac-local": clampInt(slots["mac-local"], 0, 4, fallback.handbrakeSlots["mac-local"]),
      "pc-agent": clampInt(slots["pc-agent"], 0, 4, fallback.handbrakeSlots["pc-agent"]),
    },
    processPriority: normalizePriority(raw.processPriority, fallback.processPriority),
    quiet,
    quietHours: raw.quietHours === undefined ? fallback.quietHours : sanitizeQuietHours(raw.quietHours),
    yieldWhileActive: quiet,
    userActive: {
      "mac-local": active["mac-local"] === true,
      "pc-agent": active["pc-agent"] === true,
    },
    schedule: {
      enabled: schedule.enabled === true,
      startMinute: clampInt(schedule.startMinute, 0, 1440, fallback.schedule.startMinute),
      endMinute: clampInt(schedule.endMinute, 0, 1440, fallback.schedule.endMinute),
    },
  };
}

export function hostIsQuiet(load: LoadPolicy, host: JobHost): boolean {
  if (!load.quiet && !load.yieldWhileActive) return false;
  if (host !== "mac-local" && host !== "pc-agent") return true;
  const marked = load.userActive["mac-local"] || load.userActive["pc-agent"];
  if (!marked) return true;
  return load.userActive[host] === true;
}

export function inQuietHours(load: LoadPolicy, minute = minuteNow()): boolean {
  if (load.quietHours.length === 0) return false;
  const hour = Math.floor(minute / 60) % 24;
  return load.quietHours.some((window) => hourInside(hour, window.startHour, window.endHour));
}

export async function resumeRefusal(host: JobHost | null): Promise<string | null> {
  const control = await readControl();
  if (control.paused) return "Очередь на паузе. Сначала продолжите очередь.";
  if (host && control.hosts[host]?.paused) return "Эта машина на паузе. Сначала продолжите её.";
  return null;
}

export async function decideAdmission(host: JobHost, job: AdmissionJob, running: readonly AdmissionJob[]): Promise<AdmissionDecision> {
  const control = await readControl();
  const source = job.payload?.source ?? "";
  const destination = job.payload?.destination ?? "";
  if (isIgnoredVolume(source) || isIgnoredVolume(destination)) return { ok: false, detail: "Диск Z: не используется." };
  if (control.paused) return { ok: false, detail: "Очередь на паузе." };
  if (control.hosts[host]?.paused) return { ok: false, detail: "Эта машина на паузе." };
  if (isChannelDetail(job.lastError) && !(await channelAllows(host))) {
    return { ok: false, detail: job.lastError };
  }
  if (hostIsQuiet(control.load, host)) {
    return { ok: false, detail: "На этой машине идёт игра или работа. Новые задачи ждут." };
  }
  if (inQuietHours(control.load)) {
    return { ok: false, detail: "Сейчас тихие часы. Новые задачи ждут." };
  }
  if (control.load.schedule.enabled && !inWindow(minuteNow(), control.load.schedule.startMinute, control.load.schedule.endMinute)) {
    return { ok: false, detail: "Сейчас вне расписания фоновой очереди." };
  }
  if (job.kind === "transcode") {
    const slots = host === "linux-local" ? undefined : control.load.handbrakeSlots[host];
    if (typeof slots === "number" && running.filter((item) => item.kind === "transcode").length >= slots) {
      return { ok: false, detail: "Лимит HandBrake на этой машине уже занят." };
    }
  }
  const cap = control.load.maxParallel[host] ?? 2;
  if (running.length >= cap) return { ok: false, detail: "Лимит параллельных задач на этой машине уже занят." };
  const blocked = await linkBlock(host, job.kind);
  if (blocked) return { ok: false, detail: blocked };
  return { ok: true };
}

export function inWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function snapshotHost(host: string | null): JobHost | null {
  if (!host) return null;
  if (host === "mac-local" || host === "Mac mini" || host === "demo-mac") return "mac-local";
  if (host === "pc-agent" || host === "Windows PC" || host === "Windows-ПК" || host === "demo-pc") return "pc-agent";
  if (host === "linux-local" || host === "Linux, эта машина") return "linux-local";
  return null;
}

async function channelAllows(host: JobHost): Promise<boolean> {
  const link = await currentLink();
  if (!link || link.state !== "up") return false;
  const peer = host === "linux-local" ? null : link.peers[host];
  if (peer && peer.handbrake === "down" && peer.qbittorrent === "down") return false;
  return true;
}

async function linkBlock(host: JobHost, kind: string): Promise<string | null> {
  const link = await currentLink();
  if (!link || host === "linux-local") return null;
  const peer = link.peers[host];
  if (kind === "transcode" && peer.handbrake === "down") return peer.detail || "HandBrake на этой машине не отвечает.";
  const local = localJobHost();
  if (local && host === local) return null;
  if (link.state === "down" || link.state === "recovering") {
    return peer.detail || (link.state === "recovering" ? "Адрес WSL сменился. Канал восстанавливается." : "Канал socat не запущен.");
  }
  return null;
}

async function readLinkFile(dir: string): Promise<LinkStatus | null> {
  try {
    const text = await readFile(path.join(dir, "link.json"), "utf8");
    return parseLinkStatus(JSON.parse(text));
  } catch {
    return null;
  }
}

async function load(dir: string): Promise<QueueControl> {
  try {
    const text = await readFile(path.join(dir, "queue-control.json"), "utf8");
    return sanitize(JSON.parse(text));
  } catch {
    return defaultControl();
  }
}

function sanitize(value: unknown): QueueControl {
  const base = defaultControl();
  if (!value || typeof value !== "object") return base;
  const raw = value as Partial<QueueControl>;
  const hosts = raw.hosts ?? base.hosts;
  return {
    version: 1,
    paused: raw.paused === true,
    hosts: {
      "mac-local": { paused: hosts["mac-local"]?.paused === true },
      "pc-agent": { paused: hosts["pc-agent"]?.paused === true },
      "linux-local": { paused: hosts["linux-local"]?.paused === true },
    },
    pausedByQueue: stringIds(raw.pausedByQueue),
    pausedByYield: stringIds(raw.pausedByYield),
    load: sanitizeLoad(raw.load, base.load),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
  };
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length < 80);
}

function normalizePriority(value: unknown, fallback: ProcessPriority): ProcessPriority {
  if (value === "idle" || value === "normal" || value === "below-normal") return value;
  if (value === "below") return "below-normal";
  return fallback;
}

function sanitizeQuietHours(value: unknown): QuietHour[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return list
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const raw = item as { startHour?: unknown; endHour?: unknown };
      return { startHour: clampInt(raw.startHour, 0, 24, -1), endHour: clampInt(raw.endHour, 0, 24, -1) };
    })
    .filter((item): item is QuietHour => item !== null && item.startHour >= 0 && item.endHour >= 0);
}

function hourInside(hour: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function numberOr(value: unknown, fallback: number | undefined): number {
  return typeof value === "number" ? value : fallback ?? 0;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}
