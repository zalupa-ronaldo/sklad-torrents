import { formatBytes } from "@/lib/format";

/** Disk face the main screen is allowed to show. Z: is hidden here even if a neighbor API returns it. */
export interface PanelDiskFace {
  label: string;
  namedByUser?: boolean;
  volumeName?: string;
  lastMountPath: string;
  mountPaths?: readonly string[];
  totalBytes: number;
  freeBytes: number;
  filesystem?: string;
}

export interface LoadPolicy {
  parallel: number;
  limitParallel: boolean;
  quiet: boolean;
  scheduleEnabled: boolean;
  scheduleFrom: string;
  scheduleTo: string;
}

export interface PausableJob {
  id: string;
  status: "running" | "paused" | "queued" | "completed" | "error" | "cancelled";
  progress: number;
  canPause: boolean;
}

export interface QueueTotals {
  liveCount: number;
  runningCount: number;
  processedBytes: number;
  totalBytes: number;
  progress: number;
  speed: number;
  eta: number;
}

export const LOAD_POLICY_KEY = "sklad-panel-load-v1";

const loadPolicyListeners = new Set<() => void>();
let memoryPolicy = "";

export function subscribeLoadPolicy(listener: () => void): () => void {
  loadPolicyListeners.add(listener);
  return () => {
    loadPolicyListeners.delete(listener);
  };
}

export function readLoadPolicy(): string {
  if (typeof window === "undefined") return memoryPolicy;
  try {
    return window.localStorage.getItem(LOAD_POLICY_KEY) ?? memoryPolicy;
  } catch {
    return memoryPolicy;
  }
}

export function writeLoadPolicy(policy: LoadPolicy): void {
  memoryPolicy = JSON.stringify(policy);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LOAD_POLICY_KEY, memoryPolicy);
    } catch {
      // The in-memory copy still drives this open panel.
    }
  }
  for (const listener of loadPolicyListeners) listener();
}

export function loadPolicyFromSnapshot(raw: string): LoadPolicy {
  return raw ? parseLoadPolicy(raw) : DEFAULT_LOAD_POLICY;
}

export const DEFAULT_LOAD_POLICY: LoadPolicy = {
  parallel: 2,
  limitParallel: false,
  quiet: false,
  scheduleEnabled: false,
  scheduleFrom: "01:00",
  scheduleTo: "08:00",
};

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

export function isZPath(value: string): boolean {
  const text = value.trim().replace(/\\/g, "/");
  return /^z:/i.test(text) || /^\/mnt\/z(\/|$)/i.test(text);
}

export function isHiddenPanelVolume(disk: { lastMountPath?: string; mountPaths?: readonly string[]; label?: string; name?: string }): boolean {
  const mounts = [...(disk.mountPaths ?? []), disk.lastMountPath ?? "", disk.label ?? "", disk.name ?? ""];
  return mounts.some((mount) => isZPath(mount));
}

export function driveLetter(disk: { lastMountPath: string; mountPaths?: readonly string[] }): string | null {
  const mounts = [...(disk.mountPaths ?? []), disk.lastMountPath];
  for (const mount of mounts) {
    const match = mount.match(/^([A-Za-z]):/);
    if (!match) continue;
    const letter = `${match[1].toUpperCase()}:`;
    if (letter === "Z:") continue;
    return letter;
  }
  return null;
}

function preferredLabel(disk: PanelDiskFace, letter: string | null): string {
  const candidates = disk.namedByUser ? [disk.label, disk.volumeName ?? ""] : [disk.volumeName ?? "", disk.label];
  for (const raw of candidates) {
    const value = raw.trim();
    if (!value || value === "Без имени" || /�/.test(value)) continue;
    return value;
  }
  return letter ?? "";
}

export interface PanelStrip {
  /** «1 ТБ · vault» — capacity and the volume label, not the drive letter. */
  title: string;
  /** «свободно 400 ГБ · NTFS · D:» */
  rest: string;
  /** The whole chip: title, free space, type and letter. */
  detail: string;
}

type StripFields = {
  title?: string;
  detail?: string;
  capacity?: string;
  label?: string;
  free?: string;
  filesystem?: string;
  letter?: string | null;
};

/** Chip text. Neighbor `strip` wins when the catalog already built it. */
export function panelDiskStrip(disk: PanelDiskFace & { strip?: StripFields }): PanelStrip {
  const provided = disk.strip;
  if (provided?.title && provided.detail) {
    const rest = provided.detail.startsWith(provided.title)
      ? provided.detail.slice(provided.title.length).replace(/^ · /, "")
      : provided.detail;
    return { title: provided.title, rest, detail: provided.detail };
  }
  const capacity = provided?.capacity || (disk.totalBytes > 0 ? formatBytes(disk.totalBytes) : "");
  const letter = provided?.letter || driveLetter(disk);
  const label = (provided?.label || preferredLabel(disk, letter)).trim();
  const title = [capacity, label].filter(Boolean).join(" · ") || "Диск";
  const free = provided?.free || (disk.freeBytes > 0 ? `свободно ${formatBytes(disk.freeBytes)}` : "");
  const type = (provided?.filesystem || disk.filesystem || "").trim();
  const rest = [free, type, letter && label.toUpperCase() !== letter.toUpperCase() ? letter : ""].filter(Boolean).join(" · ");
  return { title, rest, detail: rest ? `${title} · ${rest}` : title };
}

/** Full chip line. Kept for callers that want one string. */
export function panelDiskCaption(disk: PanelDiskFace & { strip?: StripFields }): string {
  return panelDiskStrip(disk).detail;
}

export type CopyGroup = "mac" | "flash" | "disk";

export function copyGroup(dest: { id: string; kind: string; label: string }): CopyGroup | null {
  if (dest.kind === "browser" || dest.id === "browser") return null;
  if (dest.kind === "mac-downloads" || dest.id === "mac-downloads") return "mac";
  if (dest.label.startsWith("Флешка")) return "flash";
  if (dest.kind === "disk") return "disk";
  return null;
}

export function folderFileCountLabel(kind: "file" | "dir", fileCount: number | null): string {
  if (kind !== "dir" || fileCount == null) return "—";
  return fileCount.toLocaleString("ru-RU");
}

/** E: and Z: are not relocate targets. Other letters stay available. */
export function relocateBlocked(path: string): string | null {
  const text = path.trim();
  if (/^z:/i.test(text)) return "Диск Z: не используется.";
  if (/^e:/i.test(text)) return "Диск E: не используется.";
  return null;
}

export function torrentMatches(
  torrent: { name: string; savePath: string; hostName: string; contentPath?: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [torrent.name, torrent.savePath, torrent.contentPath ?? "", torrent.hostName].join("\n").toLowerCase().includes(needle);
}

/** Seeding at 100% stays in the torrent list. The queue shows work that still moves or waits. */
export function isQueueJob(job: { kind?: string; status: string; progress: number }): boolean {
  if (job.status === "completed" || job.status === "cancelled") return false;
  if (job.kind === "torrent" && job.progress >= 0.999 && job.status === "running") return false;
  return job.status === "running" || job.status === "paused" || job.status === "queued" || job.status === "error";
}

export function queueTotals(
  jobs: readonly { status: PausableJob["status"]; processedBytes: number; totalBytes: number; speed: number; progress: number }[],
): QueueTotals {
  const live = jobs.filter((job) => job.status === "running" || job.status === "paused" || job.status === "queued");
  const processedBytes = live.reduce((sum, job) => sum + Math.max(0, job.processedBytes), 0);
  const totalBytes = live.reduce((sum, job) => sum + Math.max(0, job.totalBytes), 0);
  const speed = jobs.filter((job) => job.status === "running").reduce((sum, job) => sum + Math.max(0, job.speed), 0);
  const progress = totalBytes > 0 ? Math.min(1, processedBytes / totalBytes) : live.length === 0 ? 0 : live.reduce((sum, job) => sum + clamp01(job.progress), 0) / live.length;
  const eta = speed > 0 && totalBytes > processedBytes ? (totalBytes - processedBytes) / speed : 8_640_000;
  return {
    liveCount: live.length,
    runningCount: jobs.filter((job) => job.status === "running").length,
    processedBytes,
    totalBytes,
    progress,
    speed,
    eta,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function parseClock(value: string): number | null {
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** True when `now` sits inside the allowed window. An overnight window wraps past midnight. */
export function withinSchedule(now: Date, from: string, to: string): boolean {
  const start = parseClock(from);
  const end = parseClock(to);
  if (start == null || end == null || start === end) return true;
  const minute = now.getHours() * 60 + now.getMinutes();
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/**
 * Ids to pause while this panel is open.
 * Quiet mode and a closed schedule pause every running task that can pause.
 * A parallel cap keeps the tasks that have progressed furthest.
 * This never resumes a paused task.
 */
export function jobsToPause(jobs: readonly PausableJob[], policy: LoadPolicy, now: Date): string[] {
  const running = jobs.filter((job) => job.status === "running" && job.canPause);
  const stopAll = policy.quiet || (policy.scheduleEnabled && !withinSchedule(now, policy.scheduleFrom, policy.scheduleTo));
  if (stopAll) return running.map((job) => job.id);
  if (!policy.limitParallel) return [];
  const cap = Math.max(1, Math.min(8, Math.round(policy.parallel)));
  if (running.length <= cap) return [];
  return [...running].sort((a, b) => b.progress - a.progress).slice(cap).map((job) => job.id);
}

export function parseLoadPolicy(raw: string): LoadPolicy {
  try {
    const value = JSON.parse(raw) as Partial<LoadPolicy>;
    const parallel = Number(value.parallel);
    const from = typeof value.scheduleFrom === "string" && parseClock(value.scheduleFrom) != null ? value.scheduleFrom : DEFAULT_LOAD_POLICY.scheduleFrom;
    const to = typeof value.scheduleTo === "string" && parseClock(value.scheduleTo) != null ? value.scheduleTo : DEFAULT_LOAD_POLICY.scheduleTo;
    return {
      parallel: Number.isFinite(parallel) ? Math.max(1, Math.min(8, Math.round(parallel))) : DEFAULT_LOAD_POLICY.parallel,
      limitParallel: value.limitParallel === true,
      quiet: value.quiet === true,
      scheduleEnabled: value.scheduleEnabled === true,
      scheduleFrom: from,
      scheduleTo: to,
    };
  } catch {
    return DEFAULT_LOAD_POLICY;
  }
}
