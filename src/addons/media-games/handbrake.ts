import { ToolsError } from "@/addons/media-games/errors";
import { assertToolPath, pathLeaf } from "@/addons/media-games/paths";
import { findHandbrakePreset, type HandbrakePreset } from "@/addons/media-games/presets";
import type { ToolOs } from "@/addons/media-games/types";

export const MAC_HANDBRAKE_CANDIDATES = [
  "/usr/local/bin/HandBrakeCLI",
  "/opt/homebrew/bin/HandBrakeCLI",
] as const;

export const WIN_HANDBRAKE_CANDIDATES = ["C:\\Program Files\\HandBrake\\HandBrakeCLI.exe"] as const;

/** Linux-only invocation. Windows uses HandBrakeCLI.exe, not Flatpak. */
export const HANDBRAKE_FLATPAK_ID = "fr.handbrake.ghb";

export const HANDBRAKE_DISCOVERY_NOTE: Record<ToolOs, string> = {
  darwin:
    "На macOS HandBrakeCLI обычно лежит в /usr/local/bin/HandBrakeCLI или /opt/homebrew/bin/HandBrakeCLI. Склад не привозит сам бинарник.",
  win32:
    "На Windows укажите HandBrakeCLI.exe, часто C:\\Program Files\\HandBrake\\HandBrakeCLI.exe. Flatpak (flatpak run --command=HandBrakeCLI fr.handbrake.ghb) — это Linux, не ПК.",
};

const VIDEO_EXT = /\.(mkv|mp4|mov|m4v|avi|ts|wmv|webm)$/i;

export function typicalHandbrakeCandidates(os: ToolOs): readonly string[] {
  return os === "win32" ? WIN_HANDBRAKE_CANDIDATES : MAC_HANDBRAKE_CANDIDATES;
}

export function handbrakeCandidates(os: ToolOs, primary: string, extra: string): string[] {
  const listed = [primary, extra].map((item) => item.trim()).filter((item) => item && isExecutableHint(item));
  return unique([...listed, ...typicalHandbrakeCandidates(os)]);
}

export function resolveHandBrakeBinary(
  input: { os: ToolOs; handbrakePath: string; handbrakeExtra: string },
  exists: (filePath: string) => boolean,
): { binary: string; found: boolean } {
  const candidates = handbrakeCandidates(input.os, input.handbrakePath, input.handbrakeExtra);
  for (const candidate of candidates) {
    if (exists(candidate)) return { binary: candidate, found: true };
  }
  return { binary: candidates[0] || "HandBrakeCLI", found: false };
}

export function requireHandbrakePreset(id: string): HandbrakePreset {
  const preset = findHandbrakePreset(id);
  if (!preset) throw new ToolsError("validation", "Неизвестный пресет HandBrake.");
  return preset;
}

/** Argv that a real HandBrakeCLI would receive. Does not spawn anything. */
export function buildHandBrakeArgv(input: {
  binary: string;
  inputPath: string;
  outputPath: string;
  preset: string;
}): string[] {
  const binary = input.binary.trim();
  const preset = input.preset.trim();
  if (!binary) throw new ToolsError("validation", "Укажите путь к HandBrakeCLI.");
  if (!preset) throw new ToolsError("validation", "Укажите пресет HandBrake.");
  if (!input.inputPath.trim() || !input.outputPath.trim()) {
    throw new ToolsError("validation", "Нужны исходный файл и путь результата.");
  }
  return [binary, "--preset", preset, "-i", input.inputPath, "-o", input.outputPath];
}

export function suggestTranscodeOutput(os: ToolOs, inputPath: string): string {
  let normalized: string;
  try {
    normalized = assertToolPath(os, inputPath);
  } catch {
    return "";
  }
  const leaf = pathLeaf(os, normalized);
  if (!VIDEO_EXT.test(leaf)) return "";
  const sep = os === "win32" ? "\\" : "/";
  const base = leaf.replace(/\.[^.]+$/, "");
  const parent = normalized.slice(0, normalized.length - leaf.length);
  const stem = parent.endsWith(sep) || parent === "" ? parent : `${parent}${sep}`;
  return `${stem}${base}.1080p.mp4`;
}

function isExecutableHint(value: string): boolean {
  return !value.startsWith("flatpak") && value !== HANDBRAKE_FLATPAK_ID;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
