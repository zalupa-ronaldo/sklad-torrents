export type ContentClass = "video" | "audio" | "game" | "archive" | "document" | "other";

export interface PolicyDecision {
  contentClass: ContentClass;
  action: "none";
  destructive: false;
  dryRun: true;
  summary: string;
}

const VIDEO = new Set(["mkv", "mp4", "avi", "webm", "mov", "m4v"]);
const AUDIO = new Set(["mp3", "flac", "aac", "ogg", "wav"]);
const GAME = new Set(["iso", "chd", "rvz", "nsp", "xci", "cia", "wud"]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
const DOCUMENT = new Set(["txt", "pdf", "epub", "nfo", "md"]);

export function classifyContent(input: { name: string; path: string }): ContentClass {
  const ext = extension(input.name);
  const path = input.path.replace(/\\/g, "/");
  if (GAME.has(ext) || /\/Games\//i.test(path) || /\\Games\\/i.test(input.path)) return "game";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (ARCHIVE.has(ext)) return "archive";
  if (DOCUMENT.has(ext)) return "document";
  return "other";
}

export function dryRunPolicy(input: { name: string; path: string }): PolicyDecision {
  const contentClass = classifyContent(input);
  return {
    contentClass,
    action: "none",
    destructive: false,
    dryRun: true,
    summary: `Сухой прогон: класс «${contentClass}», файл остаётся на месте. Удаление и перенос не включены.`,
  };
}

function extension(name: string): string {
  const base = name.split(/[/\\]/).pop() || name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}
