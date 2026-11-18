import { NTFS_ROOT_RECORD, parseMftFixture } from "@/addons/media-games/file-index/mft";
import { buildTreePaths, type TreeNode } from "@/addons/media-games/file-index/tree";
import { classifyUsn, FILE_ATTRIBUTE_DIRECTORY, parseUsnRecords, UsnReason } from "@/addons/media-games/file-index/usn";
import type { IndexedEntry, IndexNode } from "@/lib/windows-library/types";

const DATA_CHANGE = UsnReason.DATA_OVERWRITE | UsnReason.DATA_EXTEND | UsnReason.DATA_TRUNCATION;

export function nodesFromMftFixture(bytes: Uint8Array): IndexNode[] {
  return parseMftFixture(bytes)
    .filter((entry) => entry.inUse)
    .map((entry) => ({
      fileRef: entry.recordNumber.toString(),
      parentRef: entry.parentRecord.toString(),
      name: entry.name,
      isDirectory: entry.isDirectory,
      logicalBytes: entry.isDirectory ? null : entry.size,
      allocatedBytes: null,
      compressed: null,
      algorithm: null,
    }));
}

export function entriesFromNodes(nodes: readonly IndexNode[], mount: string): IndexedEntry[] {
  const tree: TreeNode[] = nodes.map((node) => ({
    fileRef: BigInt(node.fileRef),
    parentRef: BigInt(node.parentRef),
    name: node.name,
    size: node.logicalBytes ?? 0,
    isDirectory: node.isDirectory,
  }));
  const separator = mount.includes("\\") || /^[A-Za-z]:/.test(mount) ? "\\" : "/";
  const root = mount.endsWith(separator) ? mount : `${mount}${separator}`;
  const paths = buildTreePaths(tree, root, separator);
  const out: IndexedEntry[] = [];
  for (const node of nodes) {
    if (BigInt(node.fileRef) === NTFS_ROOT_RECORD) continue;
    const full = paths.get(BigInt(node.fileRef));
    if (!full || full === root) continue;
    const relative = full.slice(root.length).replace(/\\/g, "/");
    if (!relative || relative === "." || relative.startsWith("..")) continue;
    out.push({
      relativePath: relative,
      name: node.name,
      isDirectory: node.isDirectory,
      logicalBytes: node.logicalBytes,
      allocatedBytes: node.allocatedBytes,
      compressed: node.compressed,
      algorithm: node.algorithm,
    });
  }
  return out;
}

const ROOT_REF = NTFS_ROOT_RECORD.toString();

/** Records whose parent is not in the index are counted and not given a guessed path. */
export function applyUsn(nodes: readonly IndexNode[], records: Uint8Array): { nodes: IndexNode[]; unplaced: number } {
  const byRef = new Map(nodes.map((node) => [node.fileRef, { ...node }]));
  const pending = new Set<string>();
  let unplaced = 0;
  for (const record of parseUsnRecords(records)) {
    const fileRef = record.fileRef.toString();
    const parentRef = record.parentRef.toString();
    const action = classifyUsn(record.reason);
    if (action === "rename-old") {
      if (byRef.has(fileRef)) pending.add(fileRef);
      continue;
    }
    if (action === "delete") {
      removeRef(byRef, fileRef);
      pending.delete(fileRef);
      continue;
    }
    if ((action === "rename-new" || action === "create") && !parentKnown(byRef, parentRef)) {
      unplaced += 1;
      continue;
    }
    if (action === "rename-new" || action === "create") {
      const previous = byRef.get(fileRef);
      byRef.set(fileRef, {
        fileRef,
        parentRef,
        name: record.name,
        isDirectory: (record.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 || previous?.isDirectory === true,
        logicalBytes: previous?.logicalBytes ?? null,
        allocatedBytes: previous?.allocatedBytes ?? null,
        compressed: previous?.compressed ?? null,
        algorithm: previous?.algorithm ?? null,
      });
      pending.delete(fileRef);
    }
    if ((record.reason & DATA_CHANGE) !== 0) {
      const current = byRef.get(fileRef);
      if (current && !current.isDirectory) {
        current.logicalBytes = null;
        current.allocatedBytes = null;
      }
    }
  }
  for (const fileRef of pending) removeRef(byRef, fileRef);
  return { nodes: [...byRef.values()], unplaced };
}

function parentKnown(byRef: Map<string, IndexNode>, parentRef: string): boolean {
  if (parentRef === ROOT_REF) return true;
  return byRef.has(parentRef);
}

function removeRef(byRef: Map<string, IndexNode>, fileRef: string): void {
  const drop = new Set<string>([fileRef]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of byRef.values()) {
      if (drop.has(node.parentRef) && !drop.has(node.fileRef)) {
        drop.add(node.fileRef);
        grew = true;
      }
    }
  }
  for (const ref of drop) byRef.delete(ref);
}

export function entriesFromWalk(entries: readonly IndexedEntry[]): IndexedEntry[] {
  return entries.map((entry) => ({
    ...entry,
    relativePath: entry.relativePath.replace(/\\/g, "/").replace(/^\/+/, ""),
  }));
}
