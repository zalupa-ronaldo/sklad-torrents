export type CompressionKind = "wof" | "ntfs";
export type FolderCompression = CompressionKind | "mixed";

export interface SizeFacts {
  /** Logical (uncompressed) length. */
  size: number;
  /** Allocated length of the unnamed $DATA stream. This is not WOF usage. */
  allocated: number | null;
  /** Real size of the named stream WofCompressedData, if that attribute was parsed. */
  wofBytes: number | null;
  /** A WOF reparse tag was seen and the compressed stream length was not. */
  wofUnmeasured: boolean;
  ntfsCompressed: boolean;
}

export interface OnDiskFacts {
  /** Bytes occupied on disk, or null when that figure is unknown. */
  onDisk: number | null;
  compression: CompressionKind | null;
}

/**
 * Size on disk for the panel.
 * WOF/CompactGUI usage comes only from WofCompressedData.
 * The unnamed stream length is never reported as a WOF saving.
 * A zero compressed size on a non-empty file is treated as unknown, not as a total save.
 */
export function resolveOnDisk(facts: SizeFacts): OnDiskFacts {
  if (facts.wofBytes != null) {
    if (facts.wofBytes > 0 || facts.size === 0) return { onDisk: facts.wofBytes, compression: "wof" };
    return { onDisk: null, compression: "wof" };
  }
  if (facts.wofUnmeasured) return { onDisk: null, compression: "wof" };
  if (facts.ntfsCompressed) {
    if (facts.allocated == null) return { onDisk: null, compression: "ntfs" };
    if (facts.allocated === 0 && facts.size > 0) return { onDisk: null, compression: "ntfs" };
    return { onDisk: facts.allocated, compression: "ntfs" };
  }
  if (facts.allocated == null) return { onDisk: null, compression: null };
  return { onDisk: facts.allocated, compression: null };
}

export interface RollupFile {
  size: number;
  onDisk: number | null;
  compression: FolderCompression | null;
}

export interface RollupDisk {
  size: number;
  onDisk: number | null;
  compression: FolderCompression | null;
}

/** Folder on-disk is the sum only when every child reported a real figure. Missing stays unknown, not zero. */
export function rollupOnDisk(files: readonly RollupFile[]): RollupDisk {
  let size = 0;
  let onDisk = 0;
  let unknown = false;
  let sawWof = false;
  let sawNtfs = false;
  for (const file of files) {
    size += file.size;
    if (file.compression === "wof" || file.compression === "mixed") sawWof = true;
    if (file.compression === "ntfs" || file.compression === "mixed") sawNtfs = true;
    if (file.onDisk == null) unknown = true;
    else onDisk += file.onDisk;
  }
  const compression: FolderCompression | null = sawWof && sawNtfs ? "mixed" : sawWof ? "wof" : sawNtfs ? "ntfs" : null;
  return { size, onDisk: unknown ? null : onDisk, compression };
}

export function savingsOf(size: number | null, onDisk: number | null): { bytes: number; ratio: number } | null {
  if (size == null || onDisk == null) return null;
  if (!(size > onDisk)) return null;
  return { bytes: size - onDisk, ratio: size > 0 ? (size - onDisk) / size : 0 };
}
