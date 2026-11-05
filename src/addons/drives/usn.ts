import type { IndexDelta, RawIndexedFile } from "@/addons/drives/types";
import { normalizeRelative } from "@/addons/drives/paths";

const DELETE = 0x00000100;
const RENAME_OLD = 0x00002000;

export interface UsnRecord {
  path: string;
  reason: number;
  size?: number;
  mtimeMs?: number;
}

/**
 * Parses `fsutil usn readJournal` text into a delta.
 * The delta is complete only when the tool output ends cleanly.
 */
export function parseFsutilUsn(text: string, options?: { truncated?: boolean }): IndexDelta {
  const records: UsnRecord[] = [];
  let current: Partial<UsnRecord> = {};
  const flush = () => {
    if (current.path && typeof current.reason === "number") {
      records.push({ path: current.path, reason: current.reason, size: current.size, mtimeMs: current.mtimeMs });
    }
    current = {};
  };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (key === "file name") {
      flush();
      current.path = value;
    } else if (key === "reason") {
      current.reason = Number.parseInt(value.replace(/^0x/i, ""), value.toLowerCase().startsWith("0x") ? 16 : 10);
    } else if (key === "file length" || key === "end of file") {
      const size = Number(value);
      if (Number.isFinite(size)) current.size = size;
    }
  }
  flush();
  const upserts: RawIndexedFile[] = [];
  const deletes: string[] = [];
  for (const record of records) {
    const relativePath = normalizeRelative(record.path);
    if (!relativePath) continue;
    const removed = (record.reason & DELETE) !== 0 || (record.reason & RENAME_OLD) !== 0;
    if (removed) {
      deletes.push(relativePath);
      continue;
    }
    const name = relativePath.split("/").pop() ?? relativePath;
    upserts.push({
      relativePath,
      name,
      kind: "file",
      size: record.size ?? 0,
      mtimeMs: record.mtimeMs ?? 0,
    });
  }
  return { upserts, deletes, complete: options?.truncated !== true && text.trim().length > 0 };
}

export function emptyUsnDelta(): IndexDelta {
  return { upserts: [], deletes: [], complete: false };
}
