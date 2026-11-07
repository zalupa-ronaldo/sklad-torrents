const ALTERNATE_SIZE_KEYS = ["logicalSize", "bytes", "length", "fileSize", "dataSize", "uncompressedSize"] as const;

/** A finite number, including 0. Missing or garbage is undefined so the caller can try another field. */
function parseSize(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return parsed;
  }
  return undefined;
}

/**
 * Logical length from a snapshot record.
 * An explicit 0 is a real empty file. A missing field is null — unknown, not zero.
 * Older catalogs sometimes used another name or a numeric string.
 */
export function readLogicalSize(raw: object): number | null {
  const record = raw as Record<string, unknown>;
  const direct = parseSize(record.size);
  if (direct !== undefined) return direct;
  for (const key of ALTERNATE_SIZE_KEYS) {
    const parsed = parseSize(record[key]);
    if (parsed !== undefined) return parsed;
  }
  return null;
}
