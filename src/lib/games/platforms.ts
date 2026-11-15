export const SHELF_PLATFORMS = ["windows", "macos", "switch", "psp", "ps2", "ps4"] as const;

export type ShelfPlatform = (typeof SHELF_PLATFORMS)[number];

export const PLATFORM_LABEL: Record<ShelfPlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  switch: "Switch",
  psp: "PSP",
  ps2: "PS2",
  ps4: "PS4",
};

const SWITCH_EXT = new Set(["nsp", "xci", "nsz", "nca"]);
const PSP_EXT = new Set(["cso", "pbp"]);

/** Console and Mac games stay on their own tab. An unknown image is not filed as Windows. */
export function classifyShelfPlatform(input: { name: string; path: string }): ShelfPlatform | null {
  const pathText = input.path.replace(/\\/g, "/");
  const blob = `${input.name}\n${pathText}`;
  const segments = pathText
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const ext = extensionOf(pathText);

  if (isSwitch(blob, segments, ext)) return "switch";
  if (isPsp(blob, segments, ext)) return "psp";
  if (isPs2(blob, segments, ext)) return "ps2";
  if (isPs4(blob, segments, ext)) return "ps4";
  if (isMac(segments)) return "macos";
  if (isWindows(segments, ext)) return "windows";
  return null;
}

export function extensionOf(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function isSwitch(blob: string, segments: string[], ext: string): boolean {
  if (SWITCH_EXT.has(ext)) return true;
  if (segments.some((part) => part === "switch" || part === "nx")) return true;
  return /\b0100[0-9a-f]{12}\b/i.test(blob);
}

function isPsp(blob: string, segments: string[], ext: string): boolean {
  if (PSP_EXT.has(ext)) return true;
  if (segments.some((part) => part === "psp")) return true;
  if (/\(psp\)/i.test(blob)) return true;
  return /\b(ULUS|ULES|UCUS|UCES|ULJM|ULJS|NPJH|NPUH|NPEH|ULED)\d{5}\b/i.test(blob);
}

function isPs2(blob: string, segments: string[], ext: string): boolean {
  if (segments.some((part) => part === "ps2" || part === "playstation 2")) return true;
  if (/\b(SLUS|SLES|SCUS|SCES|SLPM|SLPS|SCPS|SLED)\d{5}\b/i.test(blob)) return true;
  return (ext === "iso" || ext === "chd" || ext === "bin" || ext === "cue") && /\bps2\b|playstation\s*2/i.test(blob);
}

function isPs4(blob: string, segments: string[], ext: string): boolean {
  if (segments.some((part) => part === "ps4" || part === "playstation 4")) return true;
  if (/\bCUSA\d{5}\b/i.test(blob)) return true;
  return (ext === "pkg" || ext === "iso") && /\bps4\b|playstation\s*4/i.test(blob);
}

function isMac(segments: string[]): boolean {
  return segments.some((part) => part.endsWith(".app") || part === "macos" || part === "mac");
}

function isWindows(segments: string[], ext: string): boolean {
  if (ext === "exe") return true;
  return segments.some((part) => part === "windows" || part === "steam" || part === "steamapps" || part === "pc");
}
