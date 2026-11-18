import { sanitizeRelative, type OsKind } from "@/lib/drive/filesystem";

/** Windows volumes E: and Z: are never read, scanned, indexed, or used as a destination. */
export function isProtectedVolume(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (text.toUpperCase() === "Z:" || text.toUpperCase() === "E:") return true;
  return /^[ez]:[\\/]/i.test(text);
}

export function protectedVolumeMessage(value: string): string {
  if (/^e:/i.test(value.trim())) return "Диск E: не используется.";
  return "Диск Z: не используется.";
}

export function machineLabel(input: {
  os?: string | null;
  hostId?: string | null;
  hostName?: string | null;
  path?: string | null;
}): string {
  const os = input.os || "";
  const host = `${input.hostId || ""} ${input.hostName || ""}`.toLowerCase();
  const filePath = input.path || "";
  if (os === "darwin" || host.includes("mac") || filePath.startsWith("/Volumes/")) return "Mac";
  if (os === "win32" || host.includes("windows") || host.includes("pc-agent") || /^[a-zA-Z]:[\\/]/.test(filePath)) return "ПК";
  return "эта машина";
}

/** LocalSend file names use `/`, including a folder prefix when a directory is sent. */
export function protocolFileName(folderName: string | null, relativeInsideFolder: string, fallback: string): string {
  const leaf = relativeInsideFolder.replace(/\\/g, "/").replace(/^\/+/, "");
  const base = (leaf || fallback).split("/").filter(Boolean).join("/");
  if (!folderName) return sanitizeRelative(base.split("/").pop() || fallback);
  const segment = folderName.replace(/[\\/]/g, " ").replace(/^\.+/, "").trim() || "папка";
  return sanitizeRelative(`${segment}/${base}`);
}

export function relativeFromRoot(root: string, full: string, os: OsKind): string {
  const win = os === "win32";
  const sep = win ? "\\" : "/";
  const normalize = (value: string) => (win ? value.replace(/\//g, "\\") : value.replace(/\\/g, "/"));
  const rootPath = normalize(root).replace(/[\\/]+$/, "");
  const fullPath = normalize(full);
  const rootKey = win ? rootPath.toLowerCase() : rootPath;
  const fullKey = win ? fullPath.toLowerCase() : fullPath;
  const prefix = `${rootKey}${sep}`;
  if (fullKey === rootKey) return "";
  if (!fullKey.startsWith(prefix)) return "";
  return fullPath.slice(rootPath.length + 1).replace(/\\/g, "/");
}

export function stripMount(mount: string, full: string): string {
  const win = mount.includes("\\") || /^[a-zA-Z]:/.test(mount);
  const root = mount.replace(/[\\/]+$/, "");
  if (!root) return full.replace(/\\/g, "/");
  if (win) {
    const fullWin = full.replace(/\//g, "\\");
    if (fullWin.toLowerCase().startsWith(root.toLowerCase())) {
      return fullWin.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    }
    return full.replace(/\\/g, "/");
  }
  const fullPosix = full.replace(/\\/g, "/");
  if (fullPosix.startsWith(root)) return fullPosix.slice(root.length).replace(/^\/+/, "");
  return fullPosix;
}

export function insideFolder(folderRelative: string, fileRelative: string): string {
  const folder = folderRelative.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const file = fileRelative.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!folder) return file;
  const prefix = `${folder.toLowerCase()}/`;
  if (file.toLowerCase() === folder.toLowerCase()) return "";
  if (file.toLowerCase().startsWith(prefix)) return file.slice(folder.length + 1);
  return file;
}

export function safeRelative(value: string): string | null {
  const text = value.replace(/\\/g, "/").trim();
  if (!text || text.includes("\0") || text.startsWith("/") || /^[a-zA-Z]:/.test(text)) return null;
  const parts = text.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

export function displayInside(root: string, full: string): boolean {
  if (full === root) return false;
  const base = root.replace(/[\\/]+$/, "");
  return full.startsWith(`${base}/`) || full.startsWith(`${base}\\`);
}
