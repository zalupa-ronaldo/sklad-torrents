import { burnArgv, eraseArgv, isoArgv, isRewritable, verifyArgv, type CommandPlatform } from "@/lib/optical/commands";
import type { IndexedPath, MediaKind, OpticalAction, OpticalStep } from "@/lib/optical/media";

export interface OpticalPlan {
  /** False unless the media is rewritable AND the confirm flag was stored. */
  erase: boolean;
  steps: OpticalStep[];
  sourceDir: string;
  isoPath: string | null;
}

export function planOptical(input: {
  action: OpticalAction;
  platform: "darwin" | "win32" | "linux";
  media: MediaKind;
  eraseConfirmed: boolean;
  device: string;
  driveIndex: string | null;
  files: IndexedPath[];
  outputDir: string;
  label: string;
}): OpticalPlan {
  const platform: CommandPlatform = input.platform === "win32" ? "win32" : "darwin";
  const rewritable = isRewritable(input.media);
  const erase = input.eraseConfirmed === true && rewritable && input.action !== "iso";
  const sourceDir = sourceDirectory(input.files, input.outputDir);
  const isoPath = input.action === "erase" ? null : isoFile(input.outputDir, input.label);
  const steps: OpticalStep[] = [];

  if (input.action === "erase") {
    if (erase) {
      steps.push({
        phase: "запись",
        argv: eraseArgv(platform, input.device, input.driveIndex),
        currentFile: null,
      });
    }
    return { erase, steps, sourceDir, isoPath };
  }

  const current = input.files[0]?.name ?? null;
  steps.push({
    phase: "образ",
    argv: isoArgv(platform, sourceDir, isoPath || "disc.iso", input.label),
    currentFile: current,
  });

  if (input.action === "burn") {
    steps.push({
      phase: "запись",
      argv: burnArgv(platform, input.device, isoPath || "disc.iso", sourceDir, erase),
      currentFile: fileName(isoPath || "disc.iso"),
    });
  }

  for (const argv of verifyArgv(platform, isoPath || "disc.iso", input.device)) {
    steps.push({
      phase: "проверка",
      argv,
      currentFile: fileName(isoPath || "disc.iso"),
    });
  }

  return { erase, steps, sourceDir, isoPath };
}

export function sourceDirectory(files: IndexedPath[], outputDir: string): string {
  if (files.length === 1 && files[0].kind === "folder") return files[0].path;
  const parents = files.map((file) => parentDir(file.path));
  if (parents.length > 0 && parents.every((parent) => parent === parents[0]) && files.every((file) => file.kind === "file")) {
    return parents[0];
  }
  return joinPath(outputDir, "sklad-stage");
}

export function isoFile(outputDir: string, label: string): string {
  const safe = label.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").slice(0, 40) || "disc";
  return joinPath(outputDir, `${safe}.iso`);
}

export function isAbsoluteFolder(folder: string): boolean {
  return folder.startsWith("/") || /^[A-Za-z]:\\/.test(folder);
}

function parentDir(filePath: string): string {
  if (filePath.includes("\\")) {
    const parts = filePath.replace(/\\+$/, "").split("\\");
    parts.pop();
    return parts.join("\\") || filePath;
  }
  const parts = filePath.replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function joinPath(dir: string, name: string): string {
  if (dir.includes("\\")) return `${dir.replace(/\\+$/, "")}\\${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function fileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}
