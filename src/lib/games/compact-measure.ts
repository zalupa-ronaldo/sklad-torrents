import { spawn } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { assertEncodePaths } from "@/lib/transcode/encode-plan";

const WOF_ALGORITHM = /^(XPRESS4K|XPRESS8K|XPRESS16K|LZX)$/i;

export interface OwnedFile {
  relative: string;
  full: string;
  logical: number;
}

export interface CompactReading {
  relative: string;
  logical: number | null;
  allocated: number | null;
  /** Stored bytes of a WOF algorithm, or 0 when the query says this file is not WOF. Null is unknown. */
  wof: number | null;
}

export interface CompactAccount {
  files: number;
  logical: number | null;
  allocated: number | null;
  wof: number | null;
  known: boolean;
  compressed: boolean;
  reason: string;
}

export function decideCompact(input: { files: number; logical: number | null; allocated: number | null; wof: number | null }): CompactAccount {
  const base = { files: input.files, logical: input.logical, allocated: input.allocated, wof: input.wof };
  if (input.files <= 0 || input.logical == null || input.allocated == null || input.wof == null) {
    return {
      ...base,
      logical: input.files <= 0 ? null : input.logical,
      allocated: input.files <= 0 ? null : input.allocated,
      wof: input.files <= 0 ? null : input.wof,
      known: false,
      compressed: false,
      reason: "После compact.exe allocated и WOF неизвестны. Неизвестный размер не записывается как 0, и сжатие не засчитано.",
    };
  }
  if (input.logical < 0 || input.allocated < 0 || input.wof < 0 || input.allocated > input.logical || input.wof > input.allocated) {
    return { ...base, known: false, compressed: false, reason: "Отчёт размера не сходится. Частичная сумма не записывается, сжатие не засчитано." };
  }
  if (input.allocated < input.logical) {
    return {
      ...base,
      known: true,
      compressed: true,
      reason: `Корень измерен по своим файлам: logical ${input.logical}, allocated ${input.allocated}, WOF ${input.wof}. Это не запрос ко всему тому.`,
    };
  }
  return {
    ...base,
    known: true,
    compressed: false,
    reason: `Измерение сошлось: allocated ${input.allocated} равен logical ${input.logical}. Выгоды нет. Неизвестным размером это не считается.`,
  };
}

/** Sum only a complete file list. One unknown file makes the whole root unknown. */
export function accountReadings(files: readonly CompactReading[]): CompactAccount {
  if (files.length === 0) return decideCompact({ files: 0, logical: null, allocated: null, wof: null });
  let logical = 0;
  let allocated = 0;
  let wof = 0;
  for (const file of files) {
    if (file.logical == null || file.allocated == null || file.wof == null) {
      return decideCompact({ files: files.length, logical: null, allocated: null, wof: null });
    }
    logical += file.logical;
    allocated += file.allocated;
    wof += file.wof;
  }
  return decideCompact({ files: files.length, logical, allocated, wof });
}

export function parseCompactListing(text: string): Map<string, { logical: number; stored: number; wof: number | null }> {
  const found = new Map<string, { logical: number; stored: number; wof: number | null }>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s*:\s*(\d+)\s*=\s*\d+(?:\.\d+)?\s+to\s+1(?:\s+(\S+))?\s+(.+)$/.exec(line);
    if (!match) continue;
    const stored = Number(match[1]);
    const logical = Number(match[2]);
    const marker = match[3] || "";
    const name = match[4]!.trim();
    if (!name || !Number.isSafeInteger(stored) || !Number.isSafeInteger(logical)) continue;
    const wof = WOF_ALGORITHM.test(marker) ? stored : marker === "C" || marker === "" ? 0 : null;
    found.set(name, { logical, stored, wof });
  }
  return found;
}

export function readingsFromQuery(
  files: readonly OwnedFile[],
  sizes: ReadonlyMap<string, number | null>,
  listing: ReadonlyMap<string, { logical: number; stored: number; wof: number | null }>,
): CompactReading[] {
  return files.map((file) => {
    const listed = listing.get(file.relative) ?? listing.get(path.basename(file.relative));
    const allocated = sizes.get(file.full) ?? null;
    if (!listed || listed.wof == null || allocated == null || allocated !== listed.stored || listed.logical !== file.logical) {
      return { relative: file.relative, logical: file.logical, allocated: null, wof: null };
    }
    return { relative: file.relative, logical: file.logical, allocated, wof: listed.wof };
  });
}

export async function listOwnedFiles(root: string): Promise<{ ok: true; files: OwnedFile[] } | { ok: false; reason: string }> {
  try {
    assertEncodePaths([root]);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Путь закрыт." };
  }
  const files: OwnedFile[] = [];
  const walk = async (dir: string): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      return error instanceof Error ? error.message : "Каталог не прочитан.";
    }
    for (const entry of entries) {
      if (entry.name === ".sklad-managed") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return "В корне есть symlink или junction. Ссылка не обходится, сжатие не запускается.";
      if (entry.isDirectory()) {
        const nested = await walk(full);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile()) return "В корне есть не обычный файл. Сжатие не запускается.";
      const info = await lstat(full);
      if (info.isSymbolicLink() || !info.isFile()) return "В корне есть symlink или junction. Ссылка не обходится, сжатие не запускается.";
      const logical = (await stat(full)).size;
      files.push({ relative: path.relative(root, full), full, logical });
    }
    return null;
  };
  const error = await walk(root);
  if (error) return { ok: false, reason: error };
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return { ok: true, files };
}

export async function measureWindowsRoot(root: string): Promise<CompactAccount> {
  const listed = await listOwnedFiles(root);
  if (!listed.ok) return { ...decideCompact({ files: 0, logical: null, allocated: null, wof: null }), reason: listed.reason };
  if (process.platform !== "win32") {
    return decideCompact({ files: listed.files.length, logical: null, allocated: null, wof: null });
  }
  const [sizes, query] = await Promise.all([
    compressedSizes(listed.files.map((file) => file.full)),
    compactQuery(root),
  ]);
  if (!sizes || query == null) return decideCompact({ files: listed.files.length, logical: null, allocated: null, wof: null });
  return accountReadings(readingsFromQuery(listed.files, sizes, parseCompactListing(query)));
}

async function compressedSizes(files: readonly string[]): Promise<Map<string, number | null> | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class SkladSize {",
    "  [DllImport(\"kernel32.dll\", SetLastError=true, CharSet=CharSet.Unicode)]",
    "  public static extern uint GetCompressedFileSizeW(string name, out uint high);",
    "  public static long Of(string name) {",
    "    uint high;",
    "    uint low = GetCompressedFileSizeW(name, out high);",
    "    if (low == 0xFFFFFFFFu && Marshal.GetLastWin32Error() != 0) return -1;",
    "    return ((long)high << 32) | low;",
    "  }",
    "}",
    "'@",
    "$paths = ConvertFrom-Json $env:SKLAD_COMPACT_FILES",
    "foreach ($item in $paths) {",
    "  $size = [SkladSize]::Of([string]$item)",
    "  if ($size -lt 0) { Write-Output (@{ path = [string]$item; allocated = $null } | ConvertTo-Json -Compress) }",
    "  else { Write-Output (@{ path = [string]$item; allocated = $size } | ConvertTo-Json -Compress) }",
    "}",
  ].join("\n");
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { SKLAD_COMPACT_FILES: JSON.stringify(files) });
  if (result.code !== 0) return null;
  const sizes = new Map<string, number | null>();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { path?: string; allocated?: number | null };
      if (!parsed.path) return null;
      sizes.set(parsed.path, typeof parsed.allocated === "number" && Number.isSafeInteger(parsed.allocated) ? parsed.allocated : null);
    } catch {
      return null;
    }
  }
  return sizes;
}

async function compactQuery(root: string): Promise<string | null> {
  const result = await run("C:\\Windows\\System32\\compact.exe", ["/Q", `/S:${root}`], {});
  return result.code === 0 ? result.stdout : null;
}

function run(bin: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}
