import path from "node:path";

import { readJsonFile, writeJsonFile } from "@/lib/json-file";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import type { PathStyle } from "@/lib/qbittorrent/types";

const NAME = /^[A-Za-z0-9._-]{1,32}$/;
const COOLDOWN_MS = 30_000;
const START_ERROR = "Не удалось запустить qbittorrent-nox.";
const PROBE_ERROR = "qBittorrent не ответил. Проверьте, что Web UI запущен.";

export interface WatchdogSnapshot {
  status: "up" | "down" | "starting" | "error";
  restarts: number;
  lastError: string | null;
  checkedAt: number;
  nextStartAt: number;
}

export interface SupervisorConfig {
  enabled: boolean;
  distro: string;
  user: string;
  binary: string;
}

export interface WatchdogDeps {
  probe: () => Promise<boolean>;
  start: (args: string[]) => void | Promise<void>;
  pathStyle?: PathStyle;
  now?: number;
}

interface SupervisorFile {
  hosts: Record<string, SupervisorConfig>;
  snapshots: Record<string, WatchdogSnapshot>;
}

export function qbittorrentNoxArgs(input: { distro: string; user: string; binary?: string }): string[] {
  const distro = input.distro;
  const user = input.user;
  const binary = input.binary ?? "qbittorrent-nox";
  if (!NAME.test(distro)) throw new QbittorrentError("validation", "Некорректное имя дистрибутива WSL.");
  if (!NAME.test(user)) throw new QbittorrentError("validation", "Некорректное имя пользователя WSL.");
  if (!binary || binary.includes("/") || binary.includes("\\") || binary.includes("..")) {
    throw new QbittorrentError("validation", "Некорректное имя qbittorrent-nox.");
  }
  return ["wsl.exe", "-d", distro, "-u", user, "--", binary];
}

export function tickWatchdog(
  snapshot: WatchdogSnapshot,
  probeOk: boolean,
  canStart: boolean,
  now: number,
): { snapshot: WatchdogSnapshot; shouldStart: boolean } {
  if (probeOk) {
    return {
      snapshot: { ...snapshot, status: "up", lastError: null, checkedAt: now },
      shouldStart: false,
    };
  }
  if (!canStart) {
    return {
      snapshot: { ...snapshot, status: "down", lastError: PROBE_ERROR, checkedAt: now },
      shouldStart: false,
    };
  }
  if (now >= snapshot.nextStartAt) {
    return {
      snapshot: {
        ...snapshot,
        status: "starting",
        restarts: snapshot.restarts + 1,
        lastError: null,
        checkedAt: now,
        nextStartAt: now + COOLDOWN_MS,
      },
      shouldStart: true,
    };
  }
  return { snapshot: { ...snapshot, checkedAt: now }, shouldStart: false };
}

export async function enableQbittorrentSupervisor(
  dir: string,
  hostId: string,
  options: { distro?: string; user?: string; binary?: string } = {},
): Promise<SupervisorConfig> {
  return writeConfig(dir, hostId, true, options);
}

export async function disableQbittorrentSupervisor(dir: string, hostId: string): Promise<SupervisorConfig> {
  return writeConfig(dir, hostId, false, {});
}

export async function tickQbittorrentWatchdog(hostId: string, dir: string, deps: WatchdogDeps): Promise<WatchdogSnapshot> {
  const now = deps.now ?? Date.now();
  const file = await readSupervisor(dir);
  const config = file.hosts[hostId];
  const previous = reviveSnapshot(file.snapshots[hostId], now);
  const canStart = deps.pathStyle === "wsl" && config?.enabled === true;
  const probeOk = await deps.probe().catch(() => false);
  const decision = tickWatchdog(previous, probeOk, canStart, now);
  if (decision.shouldStart && config) {
    try {
      await deps.start(qbittorrentNoxArgs({ distro: config.distro, user: config.user, binary: config.binary }));
    } catch {
      decision.snapshot = { ...decision.snapshot, status: "error", lastError: START_ERROR };
    }
  }
  file.snapshots[hostId] = decision.snapshot;
  await writeJsonFile(supervisorPath(dir), file);
  return decision.snapshot;
}

async function writeConfig(
  dir: string,
  hostId: string,
  enabled: boolean,
  options: { distro?: string; user?: string; binary?: string },
): Promise<SupervisorConfig> {
  if (!hostId.trim()) throw new QbittorrentError("validation", "Не выбран хост.");
  const file = await readSupervisor(dir);
  const current = file.hosts[hostId];
  const next: SupervisorConfig = {
    enabled,
    distro: options.distro ?? current?.distro ?? "Ubuntu",
    user: options.user ?? current?.user ?? "brokerworker",
    binary: options.binary ?? current?.binary ?? "qbittorrent-nox",
  };
  qbittorrentNoxArgs({ distro: next.distro, user: next.user, binary: next.binary });
  file.hosts[hostId] = next;
  await writeJsonFile(supervisorPath(dir), file);
  return next;
}

async function readSupervisor(dir: string): Promise<SupervisorFile> {
  const stored = await readJsonFile<Partial<SupervisorFile>>(supervisorPath(dir), { hosts: {}, snapshots: {} });
  return {
    hosts: stored?.hosts && typeof stored.hosts === "object" ? stored.hosts : {},
    snapshots: stored?.snapshots && typeof stored.snapshots === "object" ? stored.snapshots : {},
  };
}

function reviveSnapshot(value: WatchdogSnapshot | undefined, now: number): WatchdogSnapshot {
  const blank: WatchdogSnapshot = { status: "down", restarts: 0, lastError: null, checkedAt: now, nextStartAt: 0 };
  if (!value) return blank;
  const status = value.status;
  const allowed = status === "up" || status === "down" || status === "starting" || status === "error";
  return {
    status: allowed ? status : "down",
    restarts: Number.isInteger(value.restarts) && value.restarts >= 0 ? value.restarts : 0,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    checkedAt: typeof value.checkedAt === "number" ? value.checkedAt : now,
    nextStartAt: typeof value.nextStartAt === "number" ? value.nextStartAt : 0,
  };
}

function supervisorPath(dir: string): string {
  return path.join(dir, "qb-supervisor.json");
}
