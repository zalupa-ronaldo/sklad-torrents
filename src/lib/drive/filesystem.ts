export type OsKind = "darwin" | "win32" | "linux";
export type FilesystemKind = "apfs" | "ntfs" | "other";

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Catalog filesystem for a path.
 * A Mac APFS path (`/Volumes/...` on darwin) is never reported as NTFS,
 * even if a record was mislabeled.
 */
export function resolveFilesystem(input: {
  os: OsKind;
  path: string;
  filesystem?: string | null;
}): FilesystemKind {
  const filePath = input.path.trim();
  const posix = filePath.startsWith("/");
  const windows = WINDOWS_PATH.test(filePath) || filePath.startsWith("\\\\");

  if (windows && input.os !== "darwin" && !posix) return "ntfs";
  if (input.os === "darwin" || (posix && (input.filesystem === "apfs" || input.filesystem === "ntfs"))) {
    if (input.os === "linux" && input.filesystem !== "apfs") return "other";
    return "apfs";
  }
  if (input.filesystem === "ntfs") return "ntfs";
  if (input.filesystem === "apfs") return "apfs";
  return "other";
}

export function sanitizeRelative(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("Абсолютное имя файла отклонено.");
  }
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error("Имя файла выходит из каталога назначения.");
  }
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0) throw new Error("Пустое имя файла.");
  return parts.join("/");
}

export function joinCatalogPath(os: OsKind, root: string, name: string): string {
  const relative = sanitizeRelative(name);
  if (os === "win32") {
    const base = root.replace(/\//g, "\\").replace(/\\+$/, "");
    return `${base}\\${relative.replace(/\//g, "\\")}`;
  }
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return base === "/" ? `/${relative}` : `${base}/${relative}`;
}

export function isPathUnder(os: OsKind, parent: string, child: string): boolean {
  if (child === parent) return false;
  if (os === "win32") {
    const base = parent.replace(/\//g, "\\").replace(/\\+$/, "");
    const next = child.replace(/\//g, "\\");
    return next.toLowerCase().startsWith(`${base.toLowerCase()}\\`);
  }
  const base = parent.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return child.replace(/\\/g, "/").startsWith(base === "/" ? "/" : `${base}/`);
}
