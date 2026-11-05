import { joinDisplay, normalizeRelative, parentRelative, pathSegments, segmentsStartWith } from "@/addons/drives/paths";
import type { IndexedFile, LibraryRule, MediaCategory, PathStyle, RawIndexedFile } from "@/addons/drives/types";

const CATEGORIES: readonly MediaCategory[] = ["torrent", "game", "media"];

export function asCategory(value: unknown): MediaCategory | null {
  return CATEGORIES.includes(value as MediaCategory) ? (value as MediaCategory) : null;
}

export function prefixMatches(fullPath: string, relativePath: string, prefix: string): boolean {
  const full = pathSegments(fullPath);
  const rel = pathSegments(relativePath);
  const pre = pathSegments(prefix);
  if (segmentsStartWith(full, pre)) return true;
  for (let start = 0; start < pre.length; start += 1) {
    const suffix = pre.slice(start);
    if (suffix.length > 0 && segmentsStartWith(rel, suffix)) return true;
  }
  return false;
}

export function sidecarMap(files: readonly { relativePath: string; name: string; sidecarCategory?: MediaCategory | null }[]): Map<string, MediaCategory> {
  const map = new Map<string, MediaCategory>();
  for (const file of files) {
    const category = asCategory(file.sidecarCategory);
    if (file.name !== "sklad-catalog.json" || !category) continue;
    map.set(parentRelative(file.relativePath).toLowerCase(), category);
  }
  return map;
}

export function sidecarFor(relativePath: string, map: ReadonlyMap<string, MediaCategory>): MediaCategory | null {
  let current = parentRelative(relativePath).toLowerCase();
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const found = map.get(current);
    if (found) return found;
    if (!current) return null;
    current = parentRelative(current).toLowerCase();
  }
  return null;
}

export function categoriesFor(
  relativePath: string,
  fullPath: string,
  rules: readonly LibraryRule[],
  sidecar: MediaCategory | null,
): MediaCategory[] {
  const found = new Set<MediaCategory>();
  if (sidecar) found.add(sidecar);
  for (const rule of rules) {
    if (prefixMatches(fullPath, relativePath, rule.prefix)) found.add(rule.category);
  }
  return CATEGORIES.filter((category) => found.has(category));
}

export function toIndexedFiles(
  raw: readonly RawIndexedFile[],
  rules: readonly LibraryRule[],
  style: PathStyle,
  mountPath: string,
): IndexedFile[] {
  const prepared = raw
    .map((file) => {
      const relativePath = normalizeRelative(file.relativePath);
      if (!relativePath && file.name !== "") return null;
      const name = file.name.trim() || relativePath.split("/").pop() || relativePath;
      return {
        relativePath,
        name,
        kind: file.kind === "dir" ? "dir" : "file",
        size: Number.isFinite(file.size) && file.size > 0 ? file.size : 0,
        mtimeMs: Number.isFinite(file.mtimeMs) ? file.mtimeMs : 0,
        sidecarCategory: asCategory(file.sidecarCategory),
      };
    })
    .filter((file): file is Omit<IndexedFile, "categories"> => file !== null && (file.relativePath.length > 0 || file.kind === "dir"));
  const map = sidecarMap(prepared);
  return prepared.map((file) => {
    const sidecar = file.sidecarCategory ?? sidecarFor(file.relativePath, map);
    return {
      ...file,
      sidecarCategory: sidecar,
      categories: categoriesFor(file.relativePath, joinDisplay(style, mountPath, file.relativePath), rules, sidecar),
    };
  });
}
