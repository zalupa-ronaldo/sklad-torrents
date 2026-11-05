import { IndexError } from "@/addons/media-games/file-index/errors";
import { NTFS_ROOT_RECORD } from "@/addons/media-games/file-index/mft";

export interface TreeNode {
  fileRef: bigint;
  parentRef: bigint;
  name: string;
  size: number;
  isDirectory: boolean;
}

export function isNtfsRoot(node: Pick<TreeNode, "fileRef" | "parentRef">): boolean {
  return node.fileRef === NTFS_ROOT_RECORD || node.fileRef === node.parentRef;
}

export function displayRoot(volume: string, os: "darwin" | "win32" | "linux"): string {
  if (os === "win32" && /[A-Za-z]:/.test(volume)) {
    const letter = volume.match(/[A-Za-z](?=:)/);
    if (letter) return `${letter[0].toUpperCase()}:\\`;
  }
  const normalized = volume.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function volumeKey(volume: string): string {
  const trimmed = volume.trim();
  const looksUnix = trimmed.startsWith("/") || (trimmed.startsWith("\\") && !trimmed.startsWith("\\\\.\\"));
  if (looksUnix) {
    return trimmed.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  }
  const win = trimmed.match(/^(?:\\\\\.[\\/])?([A-Za-z]):\\?$/);
  if (win) return `${win[1].toUpperCase()}:`;
  if (trimmed.startsWith("/")) return trimmed.replace(/\/+$/, "") || "/";
  return trimmed.replace(/[\\/]+$/, "");
}

/** Parent indexes from an MFT fixture or USN snapshot become full paths. */
export function buildTreePaths(nodes: TreeNode[], rootPath: string, separator: "\\" | "/"): Map<bigint, string> {
  const byId = new Map<bigint, TreeNode>();
  for (const node of nodes) byId.set(node.fileRef, node);
  const cache = new Map<bigint, string>();
  const visiting = new Set<bigint>();

  function walk(ref: bigint): string {
    const cached = cache.get(ref);
    if (cached !== undefined) return cached;
    const node = byId.get(ref);
    if (!node || isNtfsRoot(node) || ref === NTFS_ROOT_RECORD) {
      cache.set(ref, rootPath);
      return rootPath;
    }
    if (visiting.has(ref)) {
      cache.set(ref, rootPath);
      return rootPath;
    }
    visiting.add(ref);
    const parentPath = walk(node.parentRef);
    visiting.delete(ref);
    const full = joinSegment(parentPath, node.name, separator);
    cache.set(ref, full);
    return full;
  }

  for (const node of nodes) walk(node.fileRef);
  return cache;
}

export function joinSegment(parent: string, name: string, separator: "\\" | "/"): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new IndexError("Имя файла в индексе содержит недопустимые символы.");
  }
  if (parent.endsWith(separator)) return `${parent}${name}`;
  return `${parent}${separator}${name}`;
}

export function parentPathOf(fullPath: string): string {
  const separator = fullPath.includes("\\") ? "\\" : "/";
  const index = fullPath.lastIndexOf(separator);
  if (index < 0) return fullPath;
  const parent = fullPath.slice(0, index);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  if (parent === "") return separator;
  return parent;
}
