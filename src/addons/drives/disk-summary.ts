import type { DiskRecord, IndexedFile, MediaCategory } from "@/addons/drives/types";

export function emptyCategoryCounts(): Record<MediaCategory, number> {
  return { torrent: 0, game: 0, media: 0, series: 0, installer: 0, music: 0, software: 0, documents: 0 };
}

/** One pass. Does not allocate a second array of every file. */
export function summarizeIndexed(files: readonly IndexedFile[]): NonNullable<DiskRecord["summary"]> {
  const categoryCounts = emptyCategoryCounts();
  let indexedBytes = 0;
  let fileCountTotal = 0;
  let unknownSizes = 0;
  for (const file of files) {
    if (file.kind !== "file" || file.name === "sklad-catalog.json") continue;
    fileCountTotal += 1;
    if (file.size == null) unknownSizes += 1;
    else if (file.size > 0) indexedBytes += file.size;
    for (const category of file.categories) categoryCounts[category] += 1;
  }
  return { fileCount: fileCountTotal, indexedBytes, categoryCounts, ...(unknownSizes > 0 ? { unknownSizes } : {}) };
}
