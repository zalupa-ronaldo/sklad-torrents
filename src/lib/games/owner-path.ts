import { AppError } from "@/lib/app-error";
import { assertEncodePaths } from "@/lib/transcode/encode-plan";

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function assertOwnerPaths(paths: readonly string[]): void {
  try {
    assertEncodePaths(paths.filter((item) => item.trim()));
  } catch (error) {
    throw new AppError(400, error instanceof Error ? error.message : "Путь закрыт.");
  }
}

/** A path the owner already has. URLs are refused so nothing is fetched. */
export function localOwnerPath(value: string | null | undefined, label: string): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (URL_RE.test(text) || text.includes("://")) {
    throw new AppError(400, `${label}: скачивание запрещено. Нужен путь к файлу на диске.`);
  }
  assertOwnerPaths([text]);
  return text;
}

export function absoluteOwnerPath(value: string | null | undefined, label: string): string | null {
  const text = localOwnerPath(value, label);
  if (!text) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
  if (!windows && !text.startsWith("/")) {
    throw new AppError(400, `${label}: нужен полный путь к файлу на диске. Скачивание не выполняется.`);
  }
  return text;
}

export function pathStyle(filePath: string): "win32" | "posix" {
  if (/^[A-Za-z]:[\\/]/.test(filePath.trim()) || filePath.trim().startsWith("\\\\")) return "win32";
  return "posix";
}

/** Windows letters are local only on Windows. The Mac panel plans them and does not open them. */
export function pathIsLocal(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathStyle(filePath) === "win32" ? platform === "win32" : platform !== "win32";
}

export function joinStyled(root: string, leaf: string): string {
  const rel = leaf.replace(/^[\\/]+/, "");
  if (pathStyle(root) === "win32") {
    return `${root.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}`;
  }
  return `${root.replace(/\/+$/, "")}/${rel.replace(/\\/g, "/")}`;
}

export function insideRoot(root: string, target: string): boolean {
  if (pathStyle(root) === "win32") {
    const base = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    const file = target.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    return file === base || file.startsWith(`${base}\\`);
  }
  const base = root.replace(/\/+$/, "");
  const file = target.replace(/\/+$/, "");
  return file === base || file.startsWith(`${base}/`);
}
