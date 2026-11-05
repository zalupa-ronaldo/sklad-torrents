import { ToolsError } from "@/addons/media-games/errors";
import type { ToolOs } from "@/addons/media-games/types";

export function normalizeToolPath(os: ToolOs, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (os === "win32") {
    const unc = trimmed.startsWith("\\\\") || trimmed.startsWith("//");
    let folder = trimmed.replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
    if (unc) folder = `\\\\${folder.replace(/^\\+/, "")}`;
    if (/^[A-Za-z]:\\$/.test(folder)) return folder;
    return folder.replace(/\\+$/, "");
  }
  let folder = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (folder.length > 1) folder = folder.replace(/\/+$/, "");
  return folder;
}

export function assertToolPath(os: ToolOs, input: string, label = "путь"): string {
  const normalized = normalizeToolPath(os, input);
  if (!normalized) {
    throw new ToolsError("validation", `Укажите ${label}.`);
  }
  if (os === "darwin" && !normalized.startsWith("/")) {
    throw new ToolsError("validation", "На macOS путь начинается с /, например /Volumes/vault/Games/Title.");
  }
  if (os === "win32" && !/^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")) {
    throw new ToolsError("validation", "На Windows путь выглядит как D:\\Games или \\\\server\\share.");
  }
  return normalized;
}

export function sameToolPath(os: ToolOs, left: string, right: string): boolean {
  if (os === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

export function pathLeaf(os: ToolOs, input: string): string {
  const normalized = normalizeToolPath(os, input);
  const sep = os === "win32" ? "\\" : "/";
  const parts = normalized.split(sep).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

export function isNestedPath(os: ToolOs, parent: string, child: string): boolean {
  if (sameToolPath(os, parent, child)) return true;
  const sep = os === "win32" ? "\\" : "/";
  const root = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  if (os === "win32") return child.toLowerCase().startsWith(root.toLowerCase());
  return child.startsWith(root);
}

export function volumeKey(os: ToolOs, folder: string): string | null {
  if (os === "win32") {
    const match = /^([A-Za-z]):/.exec(folder);
    return match ? match[1].toUpperCase() : null;
  }
  if (folder.startsWith("/Volumes/")) {
    const name = folder.split("/")[2];
    return name ? `/Volumes/${name}` : "/Volumes";
  }
  if (folder.startsWith("/")) return "internal";
  return null;
}

export function formatArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (/[\s"]/.test(arg)) return `"${arg.replace(/"/g, '\\"')}"`;
  return arg;
}
