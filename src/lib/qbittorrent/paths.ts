import { QbittorrentError } from "@/lib/qbittorrent/errors";
import type { HostOs } from "@/lib/qbittorrent/types";

export function normalizeRemotePath(os: HostOs, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (os === "win32") {
    const unc = trimmed.startsWith("\\\\") || trimmed.startsWith("//");
    let path = trimmed.replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
    if (unc) path = `\\\\${path.replace(/^\\+/, "")}`;
    if (/^[A-Za-z]:\\$/.test(path)) return path;
    return path.replace(/\\+$/, "");
  }
  let path = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

export function joinRemotePath(os: HostOs, base: string, child: string): string {
  const root = normalizeRemotePath(os, base);
  const sep = os === "win32" ? "\\" : "/";
  const relative =
    os === "win32"
      ? child.replace(/\//g, "\\").replace(/^\\+/, "")
      : child.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative) return root;
  if (!root) return relative;
  if (root === "/" || /^[A-Za-z]:\\$/.test(root)) return `${root}${relative}`;
  return `${root}${sep}${relative}`;
}

export function assertPathForOs(os: HostOs, input: string): string {
  const normalized = normalizeRemotePath(os, input);
  if (!normalized) {
    throw new QbittorrentError("validation", "Укажите каталог назначения.");
  }
  if (os === "darwin" && !normalized.startsWith("/")) {
    throw new QbittorrentError(
      "validation",
      "На macOS путь начинается с /, например /Volumes/vault/PSP/Games/Downloads",
    );
  }
  if (os === "win32" && !/^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")) {
    throw new QbittorrentError("validation", "На Windows путь выглядит как D:\\Downloads");
  }
  return normalized;
}

const HASH_RE = /^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/;

export function assertHash(hash: string): string {
  if (!HASH_RE.test(hash)) {
    throw new QbittorrentError("validation", "Некорректный хеш раздачи.");
  }
  return hash.toLowerCase();
}

export function assertPriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < 0 || priority > 7) {
    throw new QbittorrentError("validation", "Приоритет файла должен быть целым числом от 0 до 7.");
  }
  return priority;
}
