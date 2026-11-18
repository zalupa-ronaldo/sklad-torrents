export interface FsEventLine {
  path?: string;
  cursor?: string;
  lost: boolean;
}

/** One JSON line from the Mac FSEvents helper. A dropped history is not a silent empty catalog. */
export function parseFsEventLine(line: string): FsEventLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let body: unknown;
  try {
    body = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const record = body as { path?: unknown; id?: unknown; cursor?: unknown; lost?: unknown };
  const cursor = record.cursor ?? record.id;
  return {
    path: typeof record.path === "string" ? record.path : undefined,
    cursor: typeof cursor === "number" || typeof cursor === "string" ? String(cursor) : undefined,
    lost: record.lost === true,
  };
}
