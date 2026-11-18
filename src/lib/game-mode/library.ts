import type { LibraryEntry } from "@/lib/game-mode/detect";

/** Quoted `"path" "…"` pairs from a Steam libraryfolders.vdf. Not a VDF library. */
export function parseLibraryFolders(vdf: string): string[] {
  const found: string[] = [];
  const pattern = /"path"\s+"([^"]*)"/g;
  for (const match of vdf.matchAll(pattern)) {
    const raw = (match[1] ?? "").replace(/\\\\/g, "\\").trim();
    if (!raw || raw.includes("..") || raw.includes("\0")) continue;
    found.push(raw);
  }
  return found;
}

export function parseAppManifest(text: string): { name: string; installdir: string } | null {
  const name = /"name"\s+"([^"]+)"/.exec(text)?.[1]?.trim() ?? "";
  const installdir = /"installdir"\s+"([^"]+)"/.exec(text)?.[1]?.trim() ?? "";
  if (!name || !installdir) return null;
  if (installdir.includes("..") || installdir.includes("/") || installdir.includes("\\") || installdir.includes("\0")) return null;
  return { name, installdir };
}

export function gameRoot(libraryPath: string, installdir: string): string {
  const base = libraryPath.replace(/[\\/]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base}${sep}steamapps${sep}common${sep}${installdir}`;
}

export function steamLibraryEntries(folders: readonly string[], manifests: readonly { folder: string; text: string }[]): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  for (const manifest of manifests) {
    const parsed = parseAppManifest(manifest.text);
    if (!parsed) continue;
    entries.push({
      name: parsed.name,
      root: gameRoot(manifest.folder, parsed.installdir),
      source: "steam",
    });
  }
  void folders;
  return entries;
}
