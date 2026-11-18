import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { assertEncodePaths } from "@/lib/transcode/encode-plan";

const WOF_ALGORITHM = /^(XPRESS4K|XPRESS8K|XPRESS16K|LZX)$/i;
const OEM_866 = new TextDecoder("ibm866");
const ANSI_1251 = new TextDecoder("windows-1251");
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

export type WofAlgorithm = "XPRESS4K" | "XPRESS8K" | "XPRESS16K" | "LZX";

export interface WofState {
  /** 0 when the file is not a WOF reparse. Stored bytes when it is. Null when the state was not read. */
  wof: number | null;
  algorithm: WofAlgorithm | null;
}

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

/** Reads the summary compact.exe actually printed. Quiet Russian output has no per-file line. */
export function parseCompactSummary(text: string): CompactSummary {
  const clean = text.replace(/^\uFEFF/, "");
  const ru = /Данные объ[её]мом\s+([0-9\u00a0\u202f\s]+)\s+байт сохранены в\s+([0-9\u00a0\u202f\s]+)\s+байт/i.exec(clean);
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
  /** Per-file WOF state from the Windows API. When every file is known, compact /Q is not required. */
  wofState?: ReadonlyMap<string, WofState>;
  summary: CompactSummary;
  perFile: ReadonlyMap<string, { logical: number; stored: number; wof: number | null }>;
  /** Logical size of `.sklad-managed` files skipped by the walk. compact /Q still counts them. */
  markerBytes?: number;
  markerFiles?: number;
}): CompactAccount {
  const logical = input.files.reduce((sum, file) => sum + file.logical, 0);
  const apiValues = input.files.map((file) => input.sizes.get(file.full) ?? null);
  const apiKnown = apiValues.every((value) => value != null);
  const allocated = apiKnown ? apiValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const fromApi = input.wofState ? accountFromWofState(input.files, input.sizes, input.wofState) : null;
  if (fromApi) return fromApi.known ? annotateApi(fromApi, input.summary, input.markerBytes, input.markerFiles) : fromApi;
  const perFileReadings = readingsFromQuery(input.files, input.sizes, input.perFile);
  const perFile = accountReadings(perFileReadings);
  if (perFile.known && perFile.logical === logical && perFile.allocated === allocated) return perFile;
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
  const marker = input.markerBytes ?? 0;
  const markerFiles = input.markerFiles ?? (marker > 0 ? 1 : 0);
  if (
    allocated != null
    && marker > 0
    && allocated < logical
    && input.summary.logical != null
    && input.summary.stored != null
    && input.summary.logical - logical === marker
    && input.summary.stored - allocated === marker
    && (input.summary.fileCount == null || input.summary.fileCount === input.files.length + markerFiles)
    && (input.summary.compressedCount == null || input.summary.compressedCount > 0)
  ) {
    const agreed = decideCompact({ files: input.files.length, logical, allocated, wof: allocated });
    return {
      ...agreed,
      reason: `${agreed.reason} Сводка compact /Q включает .sklad-managed (${marker} байт): logical ${input.summary.logical}, stored ${input.summary.stored}. Совпадение сводки с корнем не требуется. Имя алгоритма в сводке не названо.`,
    };
  }
  const reason = input.summary.logical == null || input.summary.stored == null
    ? "compact /Q не содержит строку stored : logical и не содержит сводку объёма. Неизвестный размер не заменяется нулём."
    : `Сводка compact /Q logical ${input.summary.logical}, stored ${input.summary.stored} не совпала с файлами корня logical ${logical}, GetCompressedFileSizeW ${allocated ?? "не прочитан"}.`;
  return { files: input.files.length, logical, allocated, wof: null, known: false, compressed: false, reason };
}

function accountFromWofState(
  files: readonly OwnedFile[],
  sizes: ReadonlyMap<string, number | null>,
  wofState: ReadonlyMap<string, WofState>,
): CompactAccount | null {
  const readings: CompactReading[] = [];
  for (const file of files) {
    const allocated = sizes.get(file.full);
    const state = wofState.get(file.full);
    if (allocated == null || allocated < 0 || !state || state.wof == null || state.wof < 0) return null;
    if (file.logical > 0 && allocated === 0) {
      readings.push({ relative: file.relative, logical: file.logical, allocated: null, wof: null });
      continue;
    }
    if (state.wof !== 0 && state.wof !== allocated) return null;
    readings.push({ relative: file.relative, logical: file.logical, allocated, wof: state.wof });
  }
  return accountReadings(readings);
}

function annotateApi(account: CompactAccount, summary: CompactSummary, markerBytes: number | undefined, markerFiles: number | undefined): CompactAccount {
  if (account.logical == null || account.allocated == null) return account;
  const source = "Источник: GetCompressedFileSizeW и состояние WOF по файлам корня. Сводка compact /Q не требуется.";
  if (summary.logical == null && summary.stored == null) {
    return { ...account, reason: `${account.reason} ${source}` };
  }
  const marker = markerBytes ?? 0;
  const markers = markerFiles ?? (marker > 0 ? 1 : 0);
  if (
    marker > 0
    && summary.logical != null
    && summary.stored != null
    && summary.logical - account.logical === marker
    && summary.stored - account.allocated === marker
    && (summary.fileCount == null || summary.fileCount === account.files + markers)
  ) {
    return { ...account, reason: `${account.reason} ${source} Сводка включает .sklad-managed (${marker} байт) и для зачёта не нужна.` };
  }
  if (summary.logical === account.logical && summary.stored === account.allocated) {
    return { ...account, reason: `${account.reason} ${source} Сводка compact /Q совпала.` };
  }
  if (summary.logical != null && summary.stored != null) {
    return {
      ...account,
      reason: `${account.reason} ${source} Сводка compact /Q logical ${summary.logical}, stored ${summary.stored} с файлами корня не сравнивалась как условие.`,
    };
  }
  return { ...account, reason: `${account.reason} ${source}` };
}

export function parseCompactListing(text: string): Map<string, { logical: number; stored: number; wof: number | null }> {
  const found = new Map<string, { logical: number; stored: number; wof: number | null }>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s*:\s*(\d+)\s*=\s*\d+(?:[.,]\d+)?\s+(?:to|к)\s+1(?:\s+(\S+))?\s+(.+)$/i.exec(line);
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

export async function listOwnedFiles(root: string): Promise<{ ok: true; files: OwnedFile[]; markerBytes: number; markerFiles: number } | { ok: false; reason: string }> {
  try {
    assertEncodePaths([root]);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Путь закрыт." };
  }
  const files: OwnedFile[] = [];
  let markerBytes = 0;
  let markerFiles = 0;
  const walk = async (dir: string): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      return error instanceof Error ? error.message : "Каталог не прочитан.";
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name === ".sklad-managed") {
        try {
          const info = await lstat(full);
          if (info.isFile() && !info.isSymbolicLink()) {
            markerBytes += info.size;
            markerFiles += 1;
          }
        } catch {
          // The marker is never part of the owned root, even when its size cannot be read.
        }
        continue;
      }
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
  return { ok: true, files, markerBytes, markerFiles };
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
  if (!sizes.ok) {
    return {
      files: listed.files.length,
      logical,
      allocated: null,
      wof: null,
      known: false,
      compressed: false,
      reason: measurementFailure(sizes, query),
    };
  }
  const account = reconcileOwnedRoot({
    files: listed.files,
    sizes: sizes.values,
    wofState: sizes.states,
    summary: parseCompactSummary(query.text),
    perFile: parseCompactListing(query.text),
    markerBytes: listed.markerBytes,
    markerFiles: listed.markerFiles,
  });
  if (account.known && !query.ok) {
    const note = query.note || `код ${query.code ?? "нет"}`;
    return { ...account, reason: `${account.reason} compact /Q не прочитан (${note}).`.trim() };
  }
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

/** Absolute Windows PowerShell paths. PATH is not consulted: an isolated PATH has no powershell.exe. */
export function windowsPowershellCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  for (const value of [env.SystemRoot, env.WINDIR, "C:\\Windows"]) {
    if (value && !roots.includes(value)) roots.push(value);
  }
  const found: string[] = [];
  for (const root of roots) {
    found.push(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    found.push(path.win32.join(root, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"));
  }
  return found;
}

async function resolveWindowsPowershell(): Promise<string> {
  const candidates = windowsPowershellCandidates();
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return candidates[0] ?? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
}

function windowsCompactExe(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.win32.join(root, "System32", "compact.exe");
}

/** PowerShell probe. Size and WOF are separate types so a WOF compile failure still returns allocated bytes. */
export function compressionProbeScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SkladSize {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern uint GetCompressedFileSizeW(string name, out uint high);
  public static long Of(string name) {
    uint high;
    uint low = GetCompressedFileSizeW(name, out high);
    if (low == 0xFFFFFFFFu && Marshal.GetLastWin32Error() != 0) return -1;
    return ((long)high << 32) | low;
  }
}
'@
$wofReady = $false
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SkladWof {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true)]
  public static extern bool GetFileInformationByHandleEx(IntPtr handle, int infoClass, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true)]
  public static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize, out uint returned, IntPtr overlapped);
  public static int State(string name) {
    int first = Probe(name, 0x02200000u, true);
    if (first != -3) return first;
    int second = Probe(name, 0x02000000u, false);
    if (second < 0) return -1;
    return second;
  }
  static int Probe(string name, uint flags, bool trustNotWof) {
    IntPtr handle = CreateFileW(name, 0x80u, 7u, IntPtr.Zero, 3u, flags, IntPtr.Zero);
    if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return -3;
    try {
      int tag = ReadTag(handle);
      int algorithm = ReadAlgorithm(handle);
      if (tag == 1 || algorithm >= 0) {
        if (algorithm >= 0 && algorithm <= 3) return algorithm;
        return 100;
      }
      if (trustNotWof && tag == 0) return -2;
      return -1;
    } finally {
      CloseHandle(handle);
    }
  }
  static int ReadTag(IntPtr handle) {
    IntPtr info = Marshal.AllocHGlobal(8);
    try {
      // 9 is FileAttributeTagInfo. 0x80000017 is IO_REPARSE_TAG_WOF.
      if (!GetFileInformationByHandleEx(handle, 9, info, 8)) return -1;
      uint tag = (uint)Marshal.ReadInt32(info, 4);
      if (tag == 0x80000017u) return 1;
      return 0;
    } finally {
      Marshal.FreeHGlobal(info);
    }
  }
  static int ReadAlgorithm(IntPtr handle) {
    IntPtr buf = Marshal.AllocHGlobal(64);
    try {
      uint returned;
      // 0x90310 is FSCTL_GET_EXTERNAL_BACKING. Provider 2 is WOF_PROVIDER_FILE.
      bool ok = DeviceIoControl(handle, 0x90310u, IntPtr.Zero, 0, buf, 64, out returned, IntPtr.Zero);
      int err = Marshal.GetLastWin32Error();
      if (!ok) {
        if (err == 234) return 100;
        if (err == 1) return -2;
        return -1;
      }
      if (returned < 16) return 100;
      uint provider = (uint)Marshal.ReadInt32(buf, 4);
      uint algorithm = (uint)Marshal.ReadInt32(buf, 12);
      if (provider != 2u || algorithm > 3u) return 100;
      return (int)algorithm;
    } finally {
      Marshal.FreeHGlobal(buf);
    }
  }
}
'@
$wofReady = $true
} catch {
[Console]::Error.WriteLine('WOF state type failed')
}
$paths = @(ConvertFrom-Json $env:SKLAD_COMPACT_FILES)
foreach ($item in $paths) {
  $path = [string]$item
  $size = [SkladSize]::Of($path)
  $code = -1
  if ($wofReady) {
    try { $code = [SkladWof]::State($path) } catch { $code = -1 }
  }
  $alloc = $null
  $wof = $null
  $alg = $null
  if ($size -ge 0) { $alloc = $size }
  if ($size -ge 0 -and $code -eq -2) { $wof = 0 }
  elseif ($size -ge 0 -and $code -ge 0 -and $code -le 3) {
    $wof = $size
    $alg = @('XPRESS4K','LZX','XPRESS8K','XPRESS16K')[$code]
  } elseif ($size -ge 0 -and $code -eq 100) {
    $wof = $size
  }
  Write-Output (@{ path = $path; allocated = $alloc; wof = $wof; algorithm = $alg } | ConvertTo-Json -Compress)
}
`.trim();
}

async function compressedSizes(files: readonly string[]): Promise<{ ok: boolean; values: Map<string, number | null>; states: Map<string, WofState>; total: number | null; code: number | null; note: string }> {
  const empty = new Map<string, number | null>();
  const states = new Map<string, WofState>();
  if (files.length === 0) return { ok: true, values: empty, states, total: 0, code: 0, note: "" };
  const bin = await resolveWindowsPowershell();
  const result = await run(bin, ["-NoProfile", "-NonInteractive", "-Command", compressionProbeScript()], { SKLAD_COMPACT_FILES: JSON.stringify(files) });
  if (result.code !== 0) return { ok: false, values: empty, states, total: null, code: result.code, note: clipDiag(result.stderr || result.error || bin) };
  const values = new Map<string, number | null>();
  for (const line of decodeProcessText(result.stdoutBuf).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { path?: string; allocated?: number | null; wof?: number | null; algorithm?: string | null };
      if (!parsed.path) return { ok: false, values, states, total: null, code: result.code, note: "Ответ GetCompressedFileSizeW не разобран." };
      const allocated = typeof parsed.allocated === "number" && Number.isSafeInteger(parsed.allocated) && parsed.allocated >= 0 ? parsed.allocated : null;
      const wof = typeof parsed.wof === "number" && Number.isSafeInteger(parsed.wof) && parsed.wof >= 0 ? parsed.wof : null;
      const algorithm = typeof parsed.algorithm === "string" && WOF_ALGORITHM.test(parsed.algorithm) ? parsed.algorithm.toUpperCase() as WofAlgorithm : null;
      values.set(parsed.path, allocated);
      states.set(parsed.path, { wof, algorithm });
    } catch {
      return { ok: false, values, states, total: null, code: result.code, note: "Ответ GetCompressedFileSizeW не разобран." };
    }
  }
  const numbers = files.map((file) => values.get(file) ?? null);
  const total = numbers.every((value) => value != null) ? numbers.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  return { ok: true, values, states, total, code: result.code, note: "" };
}

async function compactQuery(root: string): Promise<{ ok: boolean; text: string; code: number | null; note: string }> {
  const result = await run(windowsCompactExe(), ["/Q", `/S:${root}`], {});
  const text = decodeCompactOutput(result.stdoutBuf);
  if (result.code !== 0) return { ok: false, text, code: result.code, note: clipDiag(result.stderr || result.error) };
  return { ok: true, text, code: result.code, note: "" };
}

function decodeProcessText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) return buf.toString("utf16le");
  return buf.toString("utf8");
}

/** compact.exe on a Russian console writes OEM code page 866. Byte 0xFF there is a NBSP thousands separator. */
export function decodeCompactOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le").replace(/^\uFEFF/, "");
  const utf8 = strictUtf8(buf);
  if (utf8 != null && compactTextUseful(utf8)) return utf8;
  const oem = OEM_866.decode(buf).replace(/^\uFEFF/, "");
  if (compactTextUseful(oem)) return oem;
  const ansi = ANSI_1251.decode(buf).replace(/^\uFEFF/, "");
  if (compactTextUseful(ansi)) return ansi;
  if (buf.includes(0)) {
    const utf16 = buf.toString("utf16le").replace(/^\uFEFF/, "");
    if (compactTextUseful(utf16)) return utf16;
  }
  return utf8 ?? oem;
}

function strictUtf8(buf: Buffer): string | null {
  try {
    return UTF8_FATAL.decode(buf).replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

function compactTextUseful(text: string): boolean {
  const summary = parseCompactSummary(text);
  return summary.logical != null || summary.fileCount != null || parseCompactListing(text).size > 0;
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
