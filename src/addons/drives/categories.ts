import { joinDisplay, normalizeRelative, parentRelative, pathSegments, segmentsStartWith } from "@/addons/drives/paths";
import type { IndexedFile, LibraryRule, MediaCategory, PathStyle, RawIndexedFile } from "@/addons/drives/types";

const CATEGORIES: readonly MediaCategory[] = ["torrent", "game", "media", "series", "installer", "music", "software", "documents"];
const EXTENSIONS: Record<string, MediaCategory[]> = {
  mkv: ["media"], mp4: ["media"], avi: ["media"], mov: ["media"], m4v: ["media"], ts: ["media"], m2ts: ["media"], iso: ["media"],
  mp3: ["music"], flac: ["music"], wav: ["music"], ogg: ["music"], m4a: ["music"], aac: ["music"], opus: ["music"], cue: ["music"],
  exe: ["software"], msi: ["software"], msix: ["software"], appx: ["software"], dmg: ["software"], pkg: ["software"],
  pdf: ["documents"], doc: ["documents"], docx: ["documents"], txt: ["documents"], md: ["documents"], xls: ["documents"], xlsx: ["documents"], epub: ["documents"], fb2: ["documents"],
};
function inferFile(relativePath: string, kind: "file" | "dir"): MediaCategory[] {
  const lower = relativePath.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  const found = new Set<MediaCategory>();
  if (kind === "file") {
    const ext = name.includes(".") ? name.split(".").pop() ?? "" : "";
    for (const category of EXTENSIONS[ext] ?? []) found.add(category);
    if (/(^|[\/])(games? setup|установщики|installers?)([\/]|$)/.test(lower) && ["exe", "msi", "msix", "appx", "dmg", "pkg", "zip", "rar", "7z"].includes(ext)) found.add("installer");
    if (["exe", "msi", "msix", "appx", "dmg", "pkg"].includes(ext) && /setup|install|installer|установ|repack|re-pack|distribution/.test(lower)) found.add("installer");
    if (["zip", "rar", "7z"].includes(ext) && /setup|install|installer|установ|repack|re-pack/.test(lower)) found.add("installer");
    if (/(^|[\/])(games?|игры|steam|steamapps|workshop)([\/]|$)/.test(lower)) found.add("game");
    if (/(^|[\/])(series|сериалы|сирики|мульты|мультфильмы|tv[ -]?shows?)([\/]|$)|\bs\d{1,2}e\d{1,3}\b|\b\d{1,2}\s*сезон\b/.test(lower)) {
      if (found.has("media")) { found.delete("media"); found.add("series"); }
    }
    if (/(^|[\/])(music|музыка)([\/]|$)/.test(lower)) found.add("music");
    if (/(^|[\/])(комиксы|comics)([\/]|$)/.test(lower)) found.add("documents");
    if (/(^|[\/])(видеки|видео|videos?|movies?|фильмы|перекодированные)([\/]|$)/.test(lower) && found.has("media") && !found.has("series")) found.add("media");
  } else {
    if (/(^|[\/])(games?|игры|steam|steamapps|workshop)([\/]|$)/.test(lower)) found.add("game");
    if (/(^|[\/])(series|сериалы|сирики|мульты|мультфильмы|tv[ -]?shows?)([\/]|$)/.test(lower)) found.add("series");
    if (/(^|[\/])(видеки|видео|videos?|movies?|фильмы|перекодированные)([\/]|$)/.test(lower)) found.add("media");
    if (/(^|[\/])(music|музыка)([\/]|$)/.test(lower)) found.add("music");
    if (/(^|[\/])(games? setup|установщики|installers?)([\/]|$)/.test(lower)) found.add("installer");
    if (/(^|[\/])(комиксы|comics)([\/]|$)/.test(lower)) found.add("documents");
  }
  return [...found];
}

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
  for (const category of inferFile(relativePath, relativePath.endsWith("/") ? "dir" : "file")) found.add(category);
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
      const allocated = typeof file.allocated === "number" && Number.isFinite(file.allocated) && file.allocated >= 0 ? file.allocated : undefined;
      return {
        relativePath,
        name,
        kind: file.kind === "dir" ? "dir" : "file",
        size: Number.isFinite(file.size) && file.size > 0 ? file.size : 0,
        ...(allocated != null ? { allocated } : {}),
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
      categories: [...new Set([...categoriesFor(file.relativePath, joinDisplay(style, mountPath, file.relativePath), rules, sidecar), ...inferFile(file.relativePath, file.kind)])],
    };
  });
}
