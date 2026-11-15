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

export function parseGroupedNumber(raw: string): number | null {
  const digits = raw.replace(/[\s\u00a0\u202f,_]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

export interface CompactSummary {
  fileCount: number | null;
  compressedCount: number | null;
  logical: number | null;
  stored: number | null;
}

/** Reads the summary compact.exe actually printed. The Russian retest has no per-file line. */
export function parseCompactSummary(text: string): CompactSummary {
  const clean = text.replace(/^\uFEFF/, "");
  const ru = /Данные объемом\s+([0-9\u00a0\u202f\s]+)\s+байт сохранены в\s+([0-9\u00a0\u202f\s]+)\s+байт/i.exec(clean);
  const en = /([0-9][0-9,\u00a0\u202f\s]*)\s+total bytes of data are stored in\s+([0-9][0-9,\u00a0\u202f\s]*)\s+bytes/i.exec(clean);
  const pair = ru ?? en;
  const fileCount = firstNumber(clean, /Всего файлов:\s*(\d+)/i) ?? firstNumber(clean, /Of\s+(\d+)\s+files/i);
  const compressedCount = firstNumber(clean, /Из них сжато:\s*(\d+)/i) ?? firstNumber(clean, /(\d+)\s+are compressed/i);
  return {
    fileCount,
    compressedCount,
    logical: pair ? parseGroupedNumber(pair[1]!) : null,
    stored: pair ? parseGroupedNumber(pair[2]!) : null,
  };
}

function firstNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  return match ? parseGroupedNumber(match[1]!) : null;
}

export function reconcileOwnedRoot(input: {
  files: readonly OwnedFile[];
  sizes: ReadonlyMap<string, number | null>;
  summary: CompactSummary;
  perFile: ReadonlyMap<string, { logical: number; stored: number; wof: number | null }>;
}): CompactAccount {
  const logical = input.files.reduce((sum, file) => sum + file.logical, 0);
  const apiValues = input.files.map((file) => input.sizes.get(file.full) ?? null);
  const apiKnown = apiValues.every((value) => value != null);
  const allocated = apiKnown ? apiValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const perFileReadings = readingsFromQuery(input.files, input.sizes, input.perFile);
  const perFile = accountReadings(perFileReadings);
  if (perFile.known && perFile.compressed && perFile.logical === logical && perFile.allocated === allocated) return perFile;
  const summaryAgrees = input.summary.logical === logical
    && allocated != null
    && input.summary.stored === allocated
    && input.summary.fileCount === input.files.length
    && input.summary.compressedCount === input.files.length
    && allocated < logical;
  if (summaryAgrees) {
    const agreed = decideCompact({ files: input.files.length, logical, allocated, wof: allocated });
    return { ...agreed, reason: `${agreed.reason} Сводка compact /Q совпала с GetCompressedFileSizeW. Имя алгоритма в сводке не названо.` };
  }
  const reason = input.summary.logical == null || input.summary.stored == null
    ? "compact /Q не содержит строку stored : logical и не содержит сводку объёма. Неизвестный размер не заменяется нулём."
    : `Сводка compact /Q logical ${input.summary.logical}, stored ${input.summary.stored} не совпала с файлами корня logical ${logical}, GetCompressedFileSizeW ${allocated ?? "не прочитан"}.`;
  return { files: input.files.length, logical, allocated, wof: null, known: false, compressed: false, reason };
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
  const logical = listed.files.reduce((sum, file) => sum + file.logical, 0);
  if (!sizes.ok || !query.ok) {
    return {
      files: listed.files.length,
      logical,
      allocated: sizes.ok ? sizes.total : null,
      wof: null,
      known: false,
      compressed: false,
      reason: measurementFailure(sizes, query),
    };
  }
  const account = reconcileOwnedRoot({
    files: listed.files,
    sizes: sizes.values,
    summary: parseCompactSummary(query.text),
    perFile: parseCompactListing(query.text),
  });
  if (!account.known && (sizes.note || query.note)) {
    return { ...account, reason: `${account.reason} ${[sizes.note, query.note].filter(Boolean).join(" ")}`.trim() };
  }
  return account;
}

function measurementFailure(
  sizes: { ok: boolean; code: number | null; note: string },
  query: { ok: boolean; code: number | null; note: string },
): string {
  const parts = ["Измерение корня не сошлось. Сжатие заново не запускается."];
  if (!sizes.ok) parts.push(`GetCompressedFileSizeW код ${sizes.code ?? "нет"}. ${sizes.note}`.trim());
  if (!query.ok) parts.push(`compact /Q код ${query.code ?? "нет"}. ${query.note}`.trim());
  return parts.join(" ");
}

async function compressedSizes(files: readonly string[]): Promise<{ ok: boolean; values: Map<string, number | null>; total: number | null; code: number | null; note: string }> {
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
  if (result.code !== 0) return { ok: false, values: new Map(), total: null, code: result.code, note: clipDiag(result.stderr || result.error) };
  const values = new Map<string, number | null>();
  for (const line of decodeProcessText(result.stdoutBuf).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { path?: string; allocated?: number | null };
      if (!parsed.path) return { ok: false, values, total: null, code: result.code, note: "Ответ GetCompressedFileSizeW не разобран." };
      values.set(parsed.path, typeof parsed.allocated === "number" && Number.isSafeInteger(parsed.allocated) ? parsed.allocated : null);
    } catch {
      return { ok: false, values, total: null, code: result.code, note: "Ответ GetCompressedFileSizeW не разобран." };
    }
  }
  const numbers = files.map((file) => values.get(file) ?? null);
  const total = numbers.every((value) => value != null) ? numbers.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  return { ok: true, values, total, code: result.code, note: "" };
}

async function compactQuery(root: string): Promise<{ ok: boolean; text: string; code: number | null; note: string }> {
  const result = await run("C:\\Windows\\System32\\compact.exe", ["/Q", `/S:${root}`], {});
  const text = decodeCompact(result.stdoutBuf);
  if (result.code !== 0) return { ok: false, text, code: result.code, note: clipDiag(result.stderr || result.error) };
  return { ok: true, text, code: result.code, note: "" };
}

function decodeProcessText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function decodeCompact(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  const utf8 = buf.toString("utf8").replace(/^\uFEFF/, "");
  if (parseCompactSummary(utf8).logical != null || parseCompactListing(utf8).size > 0) return utf8;
  if (buf.includes(0)) {
    const utf16 = buf.toString("utf16le").replace(/^\uFEFF/, "");
    if (parseCompactSummary(utf16).logical != null || parseCompactListing(utf16).size > 0) return utf16;
  }
  return utf8;
}

export function clipDiag(text: string): string {
  return text
    .replace(/\uFEFF/g, "")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\/(?:Users|home)\/[^\s"']+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function run(bin: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stdoutBuf: Buffer; stderr: string; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outLen < 1_000_000) out.push(chunk);
      outLen += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errLen < 64_000) err.push(chunk);
      errLen += chunk.length;
    });
    child.on("error", (error) => resolve({ code: null, stdout: "", stdoutBuf: Buffer.alloc(0), stderr: "", error: error.message }));
    child.on("close", (code) => {
      const stdoutBuf = Buffer.concat(out);
      resolve({ code, stdout: stdoutBuf.toString("utf8"), stdoutBuf, stderr: Buffer.concat(err).toString("utf8"), error: "" });
    });
  });
}
