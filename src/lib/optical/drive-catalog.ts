import { readFile } from "node:fs/promises";
import path from "node:path";

import { readCatalog } from "@/addons/drives/store";
import type { DiskRecord } from "@/addons/drives/types";
import { demoIndexedPaths } from "@/lib/optical/demo";
import type { IndexedPath } from "@/lib/optical/media";
import { dataDir } from "@/lib/qbittorrent/store";

const CANDIDATES = ["drive-catalog.json", "drive-manager.json", "catalog.json"];

export async function loadIndexedPaths(): Promise<{ source: "drive-manager" | "demo"; records: IndexedPath[] }> {
  try {
    const catalog = await readCatalog();
    const fromDisks = catalog ? filesFromDisks(catalog.disks) : [];
    if (fromDisks.length > 0) return { source: "drive-manager", records: fromDisks };
  } catch {
    // A different drives.json shape belongs to another module. Fall through.
  }
  for (const name of CANDIDATES) {
    try {
      const text = await readFile(path.join(dataDir(), name), "utf8");
      const records = normalizeCatalog(JSON.parse(text) as unknown);
      if (records.length > 0) return { source: "drive-manager", records };
    } catch {
      // Missing or unreadable catalogs fall through to the demo records.
    }
  }
  return { source: "demo", records: demoIndexedPaths() };
}

export function normalizeCatalog(value: unknown): IndexedPath[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { records?: unknown }).records)
      ? (value as { records: unknown[] }).records
      : value && typeof value === "object" && Array.isArray((value as { files?: unknown }).files)
        ? (value as { files: unknown[] }).files
        : [];
  const records: IndexedPath[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const filePath = stringOf(item.path);
    if (!filePath) continue;
    const size = numberOf(item.size ?? item.bytes);
    const name = stringOf(item.name) || filePath.split(/[/\\]/).pop() || filePath;
    records.push({
      diskLabel: stringOf(item.diskLabel) || stringOf(item.label) || stringOf(item.disk) || "Диск",
      path: filePath,
      name,
      size,
      kind: item.kind === "folder" || item.kind === "dir" ? "folder" : "file",
    });
  }
  return records;
}

function filesFromDisks(disks: DiskRecord[]): IndexedPath[] {
  const records: IndexedPath[] = [];
  for (const disk of disks) {
    if (!disk || !Array.isArray(disk.files)) continue;
    for (const file of disk.files) {
      if (!file?.relativePath) continue;
      const root = (disk.lastMountPath || "").replace(/[\\/]+$/, "");
      const relative = file.relativePath.replace(/^[\\/]+/, "");
      const separator = disk.pathStyle === "win32" ? "\\" : "/";
      records.push({
        diskLabel: disk.label || disk.volumeName || "Диск",
        path: root ? `${root}${separator}${relative}` : relative,
        name: file.name || relative.split(/[/\\]/).pop() || relative,
        size: Number.isFinite(file.size) ? file.size : 0,
        kind: file.kind === "dir" ? "folder" : "file",
      });
    }
  }
  return records;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOf(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
