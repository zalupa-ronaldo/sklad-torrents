import { detectGame, workKindOfJob, workKindOfName, type LibraryEntry, type ProcessSnap, type WorkKind } from "@/lib/game-mode/detect";
import { isSteamProcess } from "@/lib/game-mode/steam";

export type GameModeName = "auto" | "on" | "off";

export interface HeldProcess {
  pid: number;
  kind: WorkKind;
}

export interface HoldState {
  mode: GameModeName;
  active: boolean;
  game: string | null;
  exe: string | null;
  source: "auto" | "manual";
  held: HeldProcess[];
  heldJobs: string[];
  heldTorrents: string[];
}

export interface GameJob {
  id: string;
  kind: string;
  pid: number | null;
  userPaused?: boolean;
}

export interface GameInput {
  mode?: GameModeName;
  processes: readonly ProcessSnap[];
  library: readonly LibraryEntry[];
  jobs: readonly GameJob[];
  downloads: readonly { hash: string }[];
}

export type GameEffect =
  | { op: "queue-pause" }
  | { op: "queue-resume" }
  | { op: "suspend"; pid: number; kind: WorkKind }
  | { op: "continue"; pid: number }
  | { op: "torrent-pause"; hash: string }
  | { op: "torrent-resume"; hash: string };

export interface GameModeView {
  active: boolean;
  mode: GameModeName;
  source: "auto" | "manual";
  game: string | null;
  exe: string | null;
  paused: { torrents: number; encode: number; nsz: number; compact: number };
  steamTouched: false;
  agent?: "ok" | "unreachable" | "mock";
}

const HASH = /^[a-f0-9]{40}$/;

export function emptyHold(): HoldState {
  return {
    mode: "auto",
    active: false,
    game: null,
    exe: null,
    source: "auto",
    held: [],
    heldJobs: [],
    heldTorrents: [],
  };
}

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647;
}

function steamPid(pid: number, processes: readonly ProcessSnap[]): boolean {
  const row = processes.find((item) => item.pid === pid);
  return row ? isSteamProcess(row.name) : false;
}

export function gameView(state: HoldState, agent?: GameModeView["agent"]): GameModeView {
  const paused = { torrents: state.heldTorrents.length, encode: 0, nsz: 0, compact: 0 };
  for (const item of state.held) paused[item.kind] += 1;
  return {
    active: state.active,
    mode: state.mode,
    source: state.source,
    game: state.game,
    exe: state.exe,
    paused,
    steamTouched: false,
    ...(agent ? { agent } : {}),
  };
}

/**
 * Soft pause only. Effects never name a kill, and a Steam pid is dropped
 * even if a caller put it in the job or process list.
 */
export function reduceGame(state: HoldState, input: GameInput): { state: HoldState; effects: GameEffect[] } {
  const mode = input.mode ?? state.mode;
  const detected = mode === "off" ? null : detectGame(input.processes, input.library);
  const active = mode === "on" ? true : mode === "off" ? false : detected !== null;
  const source = mode === "auto" ? "auto" : "manual";
  const game = active ? detected?.name ?? "Вручную" : null;
  const exe = active ? detected?.exe ?? null : null;
  if (active === state.active && mode === state.mode) {
    return { state: { ...state, mode, active, source, game, exe }, effects: [] };
  }
  if (!active) {
    const effects: GameEffect[] = [{ op: "queue-resume" }];
    for (const item of state.held) {
      if (steamPid(item.pid, input.processes)) continue;
      effects.push({ op: "continue", pid: item.pid });
    }
    for (const hash of state.heldTorrents) effects.push({ op: "torrent-resume", hash });
    return {
      state: { mode, active: false, source, game: null, exe: null, held: [], heldJobs: [], heldTorrents: [] },
      effects,
    };
  }
  const effects: GameEffect[] = [{ op: "queue-pause" }];
  const held: HeldProcess[] = [];
  const heldJobs: string[] = [];
  const seen = new Set<number>();
  const take = (pid: number, kind: WorkKind) => {
    if (!validPid(pid) || seen.has(pid) || steamPid(pid, input.processes)) return;
    seen.add(pid);
    held.push({ pid, kind });
    effects.push({ op: "suspend", pid, kind });
  };
  for (const job of input.jobs) {
    const kind = workKindOfJob(job.kind);
    if (!kind || job.userPaused === true) continue;
    heldJobs.push(job.id);
    if (job.pid !== null) take(job.pid, kind);
  }
  for (const row of input.processes) {
    const kind = workKindOfName(row.name);
    if (!kind || isSteamProcess(row.name)) continue;
    take(row.pid, kind);
  }
  const heldTorrents: string[] = [];
  for (const row of input.downloads) {
    const hash = String(row.hash || "").toLowerCase();
    if (!HASH.test(hash) || heldTorrents.includes(hash)) continue;
    heldTorrents.push(hash);
    effects.push({ op: "torrent-pause", hash });
  }
  return { state: { mode, active: true, source, game, exe, held, heldJobs, heldTorrents }, effects };
}

export interface EffectIo {
  suspend(pid: number): Promise<unknown>;
  resume(pid: number): Promise<unknown>;
  pauseQueue(): void;
  resumeQueue(): void;
  pauseTorrent(hash: string): Promise<unknown>;
  resumeTorrent(hash: string): Promise<unknown>;
  isSteamPid?(pid: number): boolean;
}

export async function applyEffects(effects: readonly GameEffect[], io: EffectIo): Promise<void> {
  for (const effect of effects) {
    if (effect.op === "queue-pause") {
      io.pauseQueue();
      continue;
    }
    if (effect.op === "queue-resume") {
      io.resumeQueue();
      continue;
    }
    if (effect.op === "suspend" || effect.op === "continue") {
      if (io.isSteamPid?.(effect.pid)) throw new Error("Процесс Steam не трогаем.");
      if (effect.op === "suspend") await io.suspend(effect.pid);
      else await io.resume(effect.pid);
      continue;
    }
    if (effect.op === "torrent-pause") await io.pauseTorrent(effect.hash);
    else await io.resumeTorrent(effect.hash);
  }
}

/** Pids and torrent hashes to continue after a crash. Steam pids in the snapshot are skipped. */
export function startupRecovery(
  saved: { pids?: readonly number[]; torrents?: readonly string[] },
  processes: readonly ProcessSnap[] = [],
): GameEffect[] {
  const effects: GameEffect[] = [];
  for (const pid of saved.pids ?? []) {
    if (!validPid(pid) || steamPid(pid, processes)) continue;
    effects.push({ op: "continue", pid });
  }
  for (const raw of saved.torrents ?? []) {
    const hash = String(raw || "").toLowerCase();
    if (!HASH.test(hash)) continue;
    effects.push({ op: "torrent-resume", hash });
  }
  return effects;
}

export function nextHeldPids(previous: readonly number[], effects: readonly GameEffect[]): number[] {
  const set = new Set(previous.filter((pid) => validPid(pid)));
  for (const effect of effects) {
    if (effect.op === "suspend" && validPid(effect.pid)) set.add(effect.pid);
    if (effect.op === "continue") set.delete(effect.pid);
  }
  return [...set];
}

export function suspendArgv(pid: number, platform: NodeJS.Platform): { bin: string; args: string[] } | { error: string } {
  if (!validPid(pid)) return { error: "Некорректный pid." };
  if (platform === "win32") {
    return {
      bin: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Suspend-Process -Id ${pid} -ErrorAction Stop`],
    };
  }
  return { bin: "kill", args: ["-STOP", String(pid)] };
}

export function continueArgv(pid: number, platform: NodeJS.Platform): { bin: string; args: string[] } | { error: string } {
  if (!validPid(pid)) return { error: "Некорректный pid." };
  if (platform === "win32") {
    return {
      bin: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Resume-Process -Id ${pid} -ErrorAction Stop`],
    };
  }
  return { bin: "kill", args: ["-CONT", String(pid)] };
}
