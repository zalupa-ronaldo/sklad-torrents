import { readFile } from "node:fs/promises";
import path from "node:path";

import { demoIndexedPaths } from "@/lib/optical/demo";
import type { IndexedPath } from "@/lib/optical/media";
import { dataDir } from "@/lib/qbittorrent/store";

const CANDIDATES = ["drive-catalog.json", "drives.json", "drive-manager.json", "catalog.json"];

export async function loadIndexedPaths(): Promise<{ source: "drive-manager" | "demo"; records: IndexedPath[] }> {
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

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOf(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
