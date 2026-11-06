import path from "node:path";

/** Relative path only inside a volume. */
export function safeRelativePath(raw: string): string | null {
  let value = String(raw || "").replace(/\\/g, "/").trim();
  if (!value || value.includes("\0")) return null;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null;
  if (/^[A-Za-z]:/.test(value)) return null;
  const parts = value.split("/").filter((part) => part.length > 0);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

export function isZMount(mount: string): boolean {
  return /^z:\\/i.test(mount) || mount.toUpperCase() === "Z:";
}

export function uniqueFileName(dir: string, baseName: string, exists: (full: string) => boolean): string {
  const safe = baseName.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_") || "file";
  let candidate = path.join(dir, safe);
  if (!exists(candidate)) return safe;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let n = 0;
  while (n < 50) {
    const name = n === 0 ? `${stem}-${stamp}${ext}` : `${stem}-${stamp}-${n}${ext}`;
    candidate = path.join(dir, name);
    if (!exists(candidate)) return name;
    n += 1;
  }
  return `${stem}-${stamp}-${Date.now()}${ext}`;
}
