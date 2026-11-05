import type { PathStyle } from "@/addons/drives/types";

export function normalizeRelative(value: string): string {
  const text = value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!text || text.split("/").some((part) => part === ".." || part === ".")) return "";
  return text;
}

export function parentRelative(value: string): string {
  const normal = normalizeRelative(value);
  const index = normal.lastIndexOf("/");
  if (index < 0) return "";
  return normal.slice(0, index);
}

export function baseName(value: string): string {
  const normal = normalizeRelative(value);
  const index = normal.lastIndexOf("/");
  return index < 0 ? normal : normal.slice(index + 1);
}

export function joinDisplay(style: PathStyle, mount: string, relativePath: string): string {
  const rel = style === "win32" ? relativePath.replace(/\//g, "\\") : relativePath;
  if (!mount) return rel;
  const sep = style === "win32" ? "\\" : "/";
  if (!rel) return mount;
  if (mount.endsWith(sep) || mount.endsWith("/")) return `${mount}${rel}`;
  return `${mount}${sep}${rel}`;
}

export function pathSegments(value: string): string[] {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

export function segmentsStartWith(value: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || prefix.length > value.length) return false;
  return prefix.every((part, index) => value[index] === part);
}
