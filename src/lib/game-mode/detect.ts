import { isSteamProcess, processBaseName } from "@/lib/game-mode/steam";

export type WorkKind = "encode" | "nsz" | "compact";

export interface ProcessSnap {
  pid: number;
  name: string;
  exePath?: string | null;
  fullscreen?: boolean;
  gpu?: boolean;
}

export interface LibraryEntry {
  name: string;
  exe?: string;
  root?: string;
  source: "steam" | "sklad";
}

export interface GameHit {
  name: string;
  exe: string;
  via: "library" | "fullscreen";
}

const ENCODE = new Set([
  "handbrakecli.exe",
  "handbrake.exe",
  "nvencc64.exe",
  "nvencc.exe",
  "svtav1encapp.exe",
  "av1an.exe",
  "ffmpeg.exe",
]);
const COMPACT = new Set(["compact.exe", "compactgui.exe"]);
const NSZ = new Set(["nsz.exe", "nsz"]);

/** Not a game: Steam, encoders, browsers, and the shell. Exact names, not prefixes. */
const NOT_A_GAME = new Set([
  ...ENCODE,
  ...COMPACT,
  ...NSZ,
  "qbittorrent.exe",
  "explorer.exe",
  "searchhost.exe",
  "dwm.exe",
  "system",
  "idle",
  "svchost.exe",
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "discord.exe",
  "applicationframehost.exe",
  "textinputhost.exe",
  "shellexperiencehost.exe",
  "startmenuexperiencehost.exe",
  "node.exe",
  "powershell.exe",
  "cmd.exe",
]);

export function workKindOfName(name: string): WorkKind | null {
  const base = processBaseName(name);
  if (ENCODE.has(base)) return "encode";
  if (NSZ.has(base)) return "nsz";
  if (COMPACT.has(base)) return "compact";
  return null;
}

export function workKindOfJob(kind: string): WorkKind | null {
  if (kind === "transcode" || kind === "handbrake") return "encode";
  if (kind === "nsz") return "nsz";
  if (kind === "compress" || kind === "compact") return "compact";
  return null;
}

function insideRoot(exePath: string, root: string): boolean {
  const file = exePath.replace(/[\\/]+$/, "");
  const dir = root.replace(/[\\/]+$/, "");
  if (!file || !dir || dir.includes("..") || file.includes("..")) return false;
  const left = file.toLowerCase();
  const base = dir.toLowerCase();
  return left.startsWith(`${base}\\`) || left.startsWith(`${base}/`);
}

function libraryHit(row: ProcessSnap, library: readonly LibraryEntry[]): GameHit | null {
  if (isSteamProcess(row.name) || workKindOfName(row.name)) return null;
  const base = processBaseName(row.name);
  for (const entry of library) {
    const exe = entry.exe ? processBaseName(entry.exe) : "";
    const byName = exe.length > 0 && exe === base;
    const byRoot = Boolean(entry.root && row.exePath && insideRoot(row.exePath, entry.root));
    if (!byName && !byRoot) continue;
    return { name: entry.name || base, exe: base, via: "library" };
  }
  return null;
}

/**
 * A library exe wins. Otherwise a fullscreen GPU app that is not Steam,
 * not an encoder, and not the shell. Ideas: Steam Big Picture pauses downloads
 * while a game is foreground; Playnite does the same. No code is copied.
 */
export function detectGame(processes: readonly ProcessSnap[], library: readonly LibraryEntry[]): GameHit | null {
  for (const row of processes) {
    if (!Number.isInteger(row.pid) || row.pid <= 0) continue;
    const hit = libraryHit(row, library);
    if (hit) return hit;
  }
  for (const row of processes) {
    if (!Number.isInteger(row.pid) || row.pid <= 0) continue;
    if (row.fullscreen !== true || row.gpu !== true) continue;
    const base = processBaseName(row.name);
    if (!base || isSteamProcess(base) || NOT_A_GAME.has(base)) continue;
    return { name: base, exe: base, via: "fullscreen" };
  }
  return null;
}
