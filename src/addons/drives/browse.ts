import { joinDisplay, normalizeRelative, parentRelative } from "@/addons/drives/paths";
import { displayDiskName, isBrowsableRecord } from "@/addons/drives/inventory";
import { mountPathsOf, online } from "@/addons/drives/reconcile";
import type { DiskRecord, MediaCategory, PathStyle } from "@/addons/drives/types";
import { DriveError } from "@/addons/drives/types";

export interface BrowseEntry {
  diskId: string;
  diskLabel: string;
  online: boolean;
  name: string;
  relativePath: string;
  displayPath: string;
  kind: "file" | "dir";
  /** Recursive for dirs, file size for files. */
  size: number;
  /** Unknown allocated → null (UI shows —). */
  allocated: number | null;
  mtimeMs: number;
  extension: string;
  categories: MediaCategory[];
  fileCount: number;
  dirCount: number;
}

export interface BrowseResponse {
  diskId: string | null;
  diskLabel: string | null;
  online: boolean;
  relativePath: string;
  parentPath: string | null;
  displayPath: string;
  entries: BrowseEntry[];
  nextCursor: number | null;
  total: number;
  roots: boolean;
  revision: string;
}

interface FolderNode {
  name: string;
  relativePath: string;
  size: number;
  fileCount: number;
  dirCount: number;
  mtimeMs: number;
  categories: Set<MediaCategory>;
  dirs: Map<string, FolderNode>;
  files: { name: string; relativePath: string; size: number; mtimeMs: number; categories: MediaCategory[]; extension: string }[];
}

interface DiskTree {
  revision: string;
  root: FolderNode;
}

const treeCache = new Map<string, DiskTree>();

function slash(relative: string): string {
  return normalizeRelative(relative);
}

function extensionOf(name: string, kind: "file" | "dir"): string {
  if (kind === "dir") return "";
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function emptyNode(name: string, relativePath: string): FolderNode {
  return {
    name,
    relativePath,
    size: 0,
    fileCount: 0,
    dirCount: 0,
    mtimeMs: 0,
    categories: new Set(),
    dirs: new Map(),
    files: [],
  };
}

function ensureChild(parent: FolderNode, name: string): FolderNode {
  let child = parent.dirs.get(name);
  if (!child) {
    const relative = parent.relativePath ? `${parent.relativePath}/${name}` : name;
    child = emptyNode(name, relative);
    parent.dirs.set(name, child);
  }
  return child;
}

function revisionOf(disk: DiskRecord): string {
  return `${disk.id}:${disk.indexRevision || ""}:${disk.files.length}:${disk.scan.status}:${disk.lastSeenAt}`;
}

/** O(n) once per disk revision — recursive size/file totals for every folder. */
export function buildDiskTree(disk: DiskRecord): DiskTree {
  const revision = revisionOf(disk);
  const cached = treeCache.get(disk.id);
  if (cached && cached.revision === revision) return cached;

  const root = emptyNode("", "");
  for (const file of disk.files) {
    if (file.name === "sklad-catalog.json") continue;
    const relative = slash(file.relativePath);
    if (!relative) continue;
    const parts = relative.split("/");
    let node = root;
    for (let i = 0; i < parts.length - (file.kind === "file" ? 1 : 0); i += 1) {
      node = ensureChild(node, parts[i]!);
    }
    if (file.kind === "file") {
      const name = file.name || parts[parts.length - 1]!;
      node.files.push({
        name,
        relativePath: relative,
        size: file.size > 0 ? file.size : 0,
        mtimeMs: file.mtimeMs || 0,
        categories: file.categories,
        extension: extensionOf(name, "file"),
      });
    } else {
      // Explicit directory row — ensure the leaf folder exists.
      let folder = root;
      for (const part of parts) folder = ensureChild(folder, part);
      for (const category of file.categories) folder.categories.add(category);
      if (file.mtimeMs > folder.mtimeMs) folder.mtimeMs = file.mtimeMs;
    }
  }

  function rollup(node: FolderNode): void {
    let size = 0;
    let fileCount = 0;
    let dirCount = node.dirs.size;
    let mtimeMs = node.mtimeMs;
    for (const file of node.files) {
      size += file.size;
      fileCount += 1;
      if (file.mtimeMs > mtimeMs) mtimeMs = file.mtimeMs;
      for (const category of file.categories) node.categories.add(category);
    }
    for (const child of node.dirs.values()) {
      rollup(child);
      size += child.size;
      fileCount += child.fileCount;
      dirCount += child.dirCount;
      if (child.mtimeMs > mtimeMs) mtimeMs = child.mtimeMs;
      for (const category of child.categories) node.categories.add(category);
    }
    node.size = size;
    node.fileCount = fileCount;
    node.dirCount = dirCount;
    node.mtimeMs = mtimeMs;
  }
  rollup(root);

  const tree = { revision, root };
  treeCache.set(disk.id, tree);
  return tree;
}

function mountOf(disk: DiskRecord): string {
  return (online(disk) ? mountPathsOf(disk)[0] : disk.lastMountPath) || disk.lastMountPath || "";
}

function findNode(root: FolderNode, relativePath: string): FolderNode | null {
  const parent = slash(relativePath);
  if (!parent) return root;
  let node: FolderNode = root;
  for (const part of parent.split("/")) {
    const next = node.dirs.get(part);
    if (!next) return null;
    node = next;
  }
  return node;
}

function listChildren(disk: DiskRecord, relativePath: string): BrowseEntry[] {
  const tree = buildDiskTree(disk);
  const node = findNode(tree.root, relativePath);
  if (!node) return [];
  const mount = mountOf(disk);
  const diskLabel = displayDiskName({
    label: disk.label,
    volumeName: disk.volumeName,
    lastMountPath: disk.lastMountPath,
    mountPaths: mountPathsOf(disk),
  });
  const isOnline = online(disk);
  const dirs: BrowseEntry[] = [...node.dirs.values()]
    .filter((child) => {
      const lower = child.name.toLowerCase();
      return lower !== "system volume information" && lower !== "$recycle.bin";
    })
    .map((child) => ({
      diskId: disk.id,
      diskLabel,
      online: isOnline,
      name: child.name,
      relativePath: child.relativePath,
      displayPath: joinDisplay(disk.pathStyle, mount, child.relativePath),
      kind: "dir" as const,
      size: child.size,
      allocated: null,
      mtimeMs: child.mtimeMs,
      extension: "",
      categories: [...child.categories].slice(0, 6),
      fileCount: child.fileCount,
      dirCount: child.dirCount,
    }));
  const files: BrowseEntry[] = node.files.map((file) => ({
    diskId: disk.id,
    diskLabel,
    online: isOnline,
    name: file.name,
    relativePath: file.relativePath,
    displayPath: joinDisplay(disk.pathStyle, mount, file.relativePath),
    kind: "file" as const,
    size: file.size,
    allocated: null,
    mtimeMs: file.mtimeMs,
    extension: file.extension,
    categories: file.categories,
    fileCount: 0,
    dirCount: 0,
  }));
  // WizTree default: largest first, dirs and files together by size.
  const all = [...dirs, ...files];
  all.sort((a, b) => b.size - a.size || b.fileCount - a.fileCount || a.name.localeCompare(b.name, "ru"));
  return all;
}

export function browseRoots(disks: readonly DiskRecord[], limit = 200, cursor = 0): BrowseResponse {
  const entries: BrowseEntry[] = [];
  for (const disk of disks) {
    if (!isBrowsableRecord(disk)) continue;
    const mount = mountOf(disk);
    const isZ = /^z:\\/i.test(disk.lastMountPath) || /^z:\\/i.test(mount);
    if (isZ && disk.files.length === 0) continue;
    // Skip empty indexes (Macintosh HD / NO NAME / blank USB) — keep letter drives with content.
    if (disk.files.length === 0) continue;
    const tree = buildDiskTree(disk);
    const name = displayDiskName({
      label: disk.label,
      volumeName: disk.volumeName,
      lastMountPath: disk.lastMountPath,
      mountPaths: mountPathsOf(disk),
    });
    entries.push({
      diskId: disk.id,
      diskLabel: name,
      online: online(disk),
      name,
      relativePath: "",
      displayPath: mount || name,
      kind: "dir",
      size: tree.root.size,
      allocated: null,
      mtimeMs: tree.root.mtimeMs,
      extension: "",
      categories: [...tree.root.categories].slice(0, 6),
      fileCount: tree.root.fileCount,
      dirCount: tree.root.dirCount,
    });
  }
  entries.sort((a, b) => b.size - a.size || b.fileCount - a.fileCount || a.name.localeCompare(b.name, "ru"));
  const slice = entries.slice(Math.max(0, cursor), Math.max(0, cursor) + Math.min(500, Math.max(1, limit)));
  return {
    diskId: null,
    diskLabel: null,
    online: true,
    relativePath: "",
    parentPath: null,
    displayPath: "Диски",
    entries: slice,
    nextCursor: cursor + slice.length < entries.length ? cursor + slice.length : null,
    total: entries.length,
    roots: true,
    revision: "roots",
  };
}

export function browseDisk(
  disks: readonly DiskRecord[],
  diskId: string,
  relativePath = "",
  limit = 200,
  cursor = 0,
): BrowseResponse {
  const disk = disks.find((item) => item.id === diskId);
  if (!disk) throw new DriveError(404, "Диск в каталоге не найден.");
  const mount = mountOf(disk);
  const isZ = /^z:\\/i.test(disk.lastMountPath) || /^z:\\/i.test(mount);
  if (isZ && disk.files.length === 0) {
    throw new DriveError(400, "Снимок Z: пуст. Диск не сканируем.");
  }
  const parent = slash(relativePath);
  const tree = buildDiskTree(disk);
  const all = listChildren(disk, parent);
  const slice = all.slice(Math.max(0, cursor), Math.max(0, cursor) + Math.min(500, Math.max(1, limit)));
  const name = displayDiskName({
    label: disk.label,
    volumeName: disk.volumeName,
    lastMountPath: disk.lastMountPath,
    mountPaths: mountPathsOf(disk),
  });
  return {
    diskId: disk.id,
    diskLabel: name,
    online: online(disk),
    relativePath: parent,
    parentPath: parent ? parentRelative(parent) : null,
    displayPath: joinDisplay(disk.pathStyle as PathStyle, mount, parent) || name,
    entries: slice,
    nextCursor: cursor + slice.length < all.length ? cursor + slice.length : null,
    total: all.length,
    roots: false,
    revision: tree.revision,
  };
}

/** Test helper — clear rollup cache between cases. */
export function clearBrowseCache(): void {
  treeCache.clear();
}
