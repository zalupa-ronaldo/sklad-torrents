import { createHash } from "node:crypto";

import { assertOpticalPath } from "@/lib/optical/paths";

export type SourceReader = (filePath: string) => Promise<Uint8Array | null>;

/** SHA-256 of every readable source. Null when any file cannot be read. Never deletes. */
export async function sourceDigest(files: { path: string }[], read: SourceReader): Promise<string | null> {
  if (files.length === 0) return null;
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const rows: string[] = [];
  for (const file of sorted) {
    assertOpticalPath(file.path);
    const bytes = await read(file.path);
    if (!bytes) return null;
    rows.push(`${file.path}\n${sha256(bytes)}`);
  }
  return sha256(new TextEncoder().encode(rows.join("\n")));
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
