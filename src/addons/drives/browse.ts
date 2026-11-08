import { rollupOnDisk, type CompressionKind, type FolderCompression } from "@/addons/drives/ondisk";
import { recordStage } from "@/addons/drives/stage";
import type { IndexedFile } from "@/addons/drives/types";
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
  /** Recursive for dirs, file size for files. Null means unknown, not zero. */
  size: number | null;
  /** Unknown allocated → null (UI shows —). Unnamed $DATA allocation, not WOF usage. */
  allocated: number | null;
  /** Measured bytes on disk. Null means unknown, not zero and not a saving. */
  onDisk: number | null;
  compression: FolderCompression | null;
  mtimeMs: number;
  extension: string;
  categories: MediaCategory[];
  fileCount: number;
  dirCount: number;
  /** False while indexedBytes is not a finished total. */
  sizesReady?: boolean;
}

export interface BrowseResponse {
  diskId: string | null;
  diskLabel: string | null;
  online: boolean;
  relativePath: string;
  parentPath: string | null;
  displayPath: string;
  entries: BrowseEntry[];
  /** Byte total of the listed folder (or of every disk root). Percents use this, not file counts. */
  scopeBytes: number;
  nextCursor: number | null;
  total: number;
  roots: boolean;
  revision: string;
}

interface FolderNode {
  name: string;
  relativePath: string;
  size: number | null;
  /** Null until at least one descendant reports an allocated length. */
  allocated: number | null;
  onDisk: number | null;
  compression: FolderCompression | null;
  fileCount: number;
  dirCount: number;
  mtimeMs: number;
  categories: Set<MediaCategory>;
  dirs: Map<string, FolderNode>;
  files: { name: string; relativePath: string; size: number | null; allocated: number | null; onDisk: number | null; compression: CompressionKind | null; mtimeMs: number; categories: MediaCategory[]; extension: string }[];
}

interface DiskTree {
  revision: string;
  root: FolderNode;
}

const treeCache = new Map<string, DiskTree>();

function slash(relative: string): string {
  return normalizeRelative(relative);
}

function compareSizeDesc(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
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
    allocated: null,
    onDisk: null,
    compression: null,
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
  // lastSeenAt changes on every shelf poll and must not rebuild a million-row tree.
  return `${disk.id}:${disk.indexRevision || ""}:${disk.files.length}:${disk.summary?.indexedBytes ?? ""}:${disk.scan.status}`;
}

function insertFile(root: FolderNode, file: IndexedFile): void {
  if (file.name === "sklad-catalog.json") return;
  const relative = slash(file.relativePath);
  if (!relative) return;
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
      size: file.size == null ? null : file.size,
      allocated: typeof file.allocated === "number" ? file.allocated : null,
      onDisk: typeof file.onDisk === "number" ? file.onDisk : null,
      compression: file.compression === "wof" || file.compression === "ntfs" ? file.compression : null,
      mtimeMs: file.mtimeMs || 0,
      categories: file.categories,
      extension: extensionOf(name, "file"),
    });
    return;
  }
  let folder = root;
  for (const part of parts) folder = ensureChild(folder, part);
  for (const category of file.categories) folder.categories.add(category);
  if (file.mtimeMs > folder.mtimeMs) folder.mtimeMs = file.mtimeMs;
}

/** O(n) once per disk revision — recursive size/file totals for every folder. */
export function buildDiskTree(disk: DiskRecord): DiskTree {
  const revision = revisionOf(disk);
  const cached = treeCache.get(disk.id);
  if (cached && cached.revision === revision) return cached;

  const root = emptyNode("", "");
  for (const file of disk.files) insertFile(root, file);
  return finishTree(disk.id, root, revision);
}

function rollupTree(node: FolderNode): void {
    let size = 0;
    let sizeKnown = true;
    let allocated = 0;
    let allocatedKnown = false;
    let fileCount = 0;
    let dirCount = node.dirs.size;
    let mtimeMs = node.mtimeMs;
    const addSize = (value: number | null) => {
      if (value == null) sizeKnown = false;
      else size += value;
    };
    const addAllocated = (value: number | null) => {
      if (value == null) return;
      allocated += value;
      allocatedKnown = true;
    };
    for (const file of node.files) {
      addSize(file.size);
      addAllocated(file.allocated);
      fileCount += 1;
      if (file.mtimeMs > mtimeMs) mtimeMs = file.mtimeMs;
      for (const category of file.categories) node.categories.add(category);
    }
    for (const child of node.dirs.values()) {
      rollupTree(child);
      addSize(child.size);
      addAllocated(child.allocated);
      fileCount += child.fileCount;
      dirCount += child.dirCount;
      if (child.mtimeMs > mtimeMs) mtimeMs = child.mtimeMs;
      for (const category of child.categories) node.categories.add(category);
    }
    const disk = rollupOnDisk([
      ...node.files.map((file) => ({ size: file.size ?? 0, onDisk: file.onDisk, compression: file.compression })),
      ...[...node.dirs.values()].map((child) => ({ size: child.size ?? 0, onDisk: child.onDisk, compression: child.compression })),
    ]);
    node.size = sizeKnown ? size : null;
    node.allocated = allocatedKnown ? allocated : null;
    node.onDisk = disk.onDisk;
    node.compression = disk.compression;
    node.fileCount = fileCount;
    node.dirCount = dirCount;
    node.mtimeMs = mtimeMs;
}

function finishTree(diskId: string, root: FolderNode, revision: string): DiskTree {
  rollupTree(root);
  const tree = { revision, root };
  treeCache.set(diskId, tree);
  return tree;
}

/** Same tree, but a large index returns to the event loop so a shelf request is not frozen. */
export async function buildDiskTreeCooperative(disk: DiskRecord): Promise<DiskTree> {
  const revision = revisionOf(disk);
  const cached = treeCache.get(disk.id);
  if (cached && cached.revision === revision) return cached;
  if (disk.files.length < 12_000) return buildDiskTree(disk);
  const started = performance.now();
  const root = emptyNode("", "");
  let gapStarted = performance.now();
  for (let i = 0; i < disk.files.length; i += 1) {
    insertFile(root, disk.files[i]!);
    if (i > 0 && i % 8_000 === 0) {
      recordStage("browse-tree-gap", performance.now() - gapStarted, 8_000);
      await new Promise((resolve) => setImmediate(resolve));
      gapStarted = performance.now();
    }
  }
  const tree = finishTree(disk.id, root, revision);
  recordStage("browse-tree", performance.now() - started, disk.files.length);
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
      allocated: child.allocated,
      onDisk: child.onDisk,
      compression: child.compression,
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
      allocated: file.allocated,
      onDisk: file.onDisk,
      compression: file.compression,
    mtimeMs: file.mtimeMs,
    extension: file.extension,
    categories: file.categories,
    fileCount: 0,
    dirCount: 0,
  }));
  // WizTree default: largest first, dirs and files together by size.
  const all = [...dirs, ...files];
  all.sort((a, b) => compareSizeDesc(a.size, b.size) || b.fileCount - a.fileCount || a.name.localeCompare(b.name, "ru"));
  return all;
}

export function browseRoots(disks: readonly DiskRecord[], limit = 200, cursor = 0): BrowseResponse {
  const entries: BrowseEntry[] = [];
  for (const disk of disks) {
    if (!isBrowsableRecord(disk, disks)) continue;
    const mount = mountOf(disk);
    const connected = online(disk);
    // An empty offline placeholder stays out of the tree. A connected disk stays, even with no index.
    if (disk.files.length === 0 && !connected && !disk.summary && !(disk.reportedRecords && disk.reportedRecords > 0)) continue;
    const shardReady = (disk.summary?.fileCount ?? 0) > 0 && (disk.shardBytes ?? 0) > 0 && !disk.pendingRevision;
    const waiting = disk.files.length === 0 && !shardReady && (
      Boolean(disk.pendingRevision) ||
      (disk.ingest != null && disk.ingest.phase !== "done") ||
      (disk.reportedRecords ?? 0) > 0
    );
    const summarized = !waiting && Boolean(disk.summary) && disk.files.length === 0 && (disk.summary?.fileCount ?? 0) > 0;
    const tree = summarized || waiting ? null : buildDiskTree(disk);
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
      size: waiting ? null : tree ? tree.root.size : disk.summary && (disk.summary.unknownSizes ?? 0) > 0 && disk.summary.indexedBytes === 0 ? null : (disk.summary?.indexedBytes ?? 0),
      allocated: tree ? tree.root.allocated : null,
      onDisk: tree ? tree.root.onDisk : null,
      compression: tree ? tree.root.compression : null,
      mtimeMs: tree ? tree.root.mtimeMs : 0,
      extension: "",
      categories: tree ? [...tree.root.categories].slice(0, 6) : [],
      fileCount: tree ? tree.root.fileCount : (disk.summary?.fileCount ?? disk.reportedRecords ?? 0),
      dirCount: tree ? tree.root.dirCount : 0,
      sizesReady: waiting ? false : Boolean(tree) || Boolean(disk.summary && (disk.summary.fileCount > 0 || disk.files.length > 0)),
    });
  }
  entries.sort((a, b) => compareSizeDesc(a.size, b.size) || b.fileCount - a.fileCount || a.name.localeCompare(b.name, "ru"));
  const scopeBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const slice = entries.slice(Math.max(0, cursor), Math.max(0, cursor) + Math.min(500, Math.max(1, limit)));
  return {
    diskId: null,
    diskLabel: null,
    online: true,
    relativePath: "",
    parentPath: null,
    displayPath: "Диски",
    entries: slice,
    scopeBytes,
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
  const parent = slash(relativePath);
  const tree = buildDiskTree(disk);
  const folder = findNode(tree.root, parent);
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
    scopeBytes: folder?.size ?? 0,
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
