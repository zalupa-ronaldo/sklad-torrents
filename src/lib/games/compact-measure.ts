import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/**
 * allocated is the on-disk total of owned files (GetCompressedFileSizeW), without `.sklad-managed`.
 * wof is only the on-disk bytes of files that actually carry WOF backing.
 * A file that did not shrink, and a file the WOF tag says is not external, contributes 0.
 * The folder allocated total is never copied into wof. For the PR25 fixture that is
 * allocated 36961 (36864 + 97) and wof 36864 (payload.bin only).
 */
export interface CompactAccount {
  files: number;
  logical: number | null;
  /** Sum of compressed sizes of owned files. Not the same number as `wof`. */
  allocated: number | null;
  /** Sum of compressed sizes of WOF-backed files only. */
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
  if (fromApi) return fromApi.known ? annotateApi(fromApi, input.summary, input.markerBytes, input.markerFiles, "Источник: GetCompressedFileSizeW и состояние WOF по файлам корня. Сводка compact /Q не требуется.") : fromApi;
  const fromSizes = accountFromAllocated(input.files, input.sizes);
  if (fromSizes?.known) {
    return annotateApi(fromSizes, input.summary, input.markerBytes, input.markerFiles, "Источник: GetCompressedFileSizeW по файлам корня. Сводка compact /Q не требуется.");
  }
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
  const marked = summaryMinusMarker({
    summary: input.summary,
    logical,
    allocated,
    files: input.files.length,
    marker: input.markerBytes ?? 0,
    markerCount: input.markerFiles ?? ((input.markerBytes ?? 0) > 0 ? 1 : 0),
  });
  if (marked) return marked;
  const reason = input.summary.logical == null || input.summary.stored == null
    ? "compact /Q не содержит строку stored : logical и не содержит сводку объёма. Неизвестный размер не заменяется нулём."
    : `Сводка compact /Q logical ${input.summary.logical}, stored ${input.summary.stored} не совпала с файлами корня logical ${logical}, GetCompressedFileSizeW ${allocated ?? "не прочитан"}.`;
  return { files: input.files.length, logical, allocated, wof: null, known: false, compressed: false, reason };
}

/** compact /Q counts `.sklad-managed`; the owned walk does not. The difference is not a failed measurement. */
function summaryMinusMarker(input: {
  summary: CompactSummary;
  logical: number;
  allocated: number | null;
  files: number;
  marker: number;
  markerCount: number;
}): CompactAccount | null {
  if (input.marker <= 0) return null;
  const summary = input.summary;
  if (summary.logical == null || summary.stored == null) return null;
  if (summary.logical - input.logical !== input.marker) return null;
  if (summary.fileCount != null && summary.fileCount !== input.files + input.markerCount) return null;
  const implied = summary.stored - input.marker;
  if (!Number.isSafeInteger(implied) || implied < 0 || implied > input.logical) return null;
  if (input.allocated != null && input.allocated !== implied) return null;
  if (implied < input.logical && summary.compressedCount === 0) return null;
  return {
    files: input.files,
    logical: input.logical,
    allocated: implied,
    wof: null,
    known: false,
    compressed: false,
    reason: `allocated корня ${implied}: сводка compact /Q stored ${summary.stored} без .sklad-managed (${input.marker} байт). wofBytes считает только файлы с подложкой WOF, а не весь allocated ${implied}. Пофайловое состояние WOF не прочитано.`,
  };
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

/** Tag was not read. A file that did not shrink is not WOF. A smaller file contributes only its stored size. */
function accountFromAllocated(files: readonly OwnedFile[], sizes: ReadonlyMap<string, number | null>): CompactAccount | null {
  if (files.length === 0) return null;
  const readings: CompactReading[] = [];
  for (const file of files) {
    const allocated = sizes.get(file.full);
    if (allocated == null || allocated < 0 || allocated > file.logical) return null;
    if (file.logical > 0 && allocated === 0) return null;
    readings.push({ relative: file.relative, logical: file.logical, allocated, wof: allocated < file.logical ? allocated : 0 });
  }
  const account = accountReadings(readings);
  return account.known ? account : null;
}

function annotateApi(account: CompactAccount, summary: CompactSummary, markerBytes: number | undefined, markerFiles: number | undefined, source: string): CompactAccount {
  if (account.logical == null || account.allocated == null) return account;
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

export async function measureWindowsRoot(root: string, options?: { debugProbe?: boolean }): Promise<CompactAccount & { probe?: ProbeDiagnostic }> {
  const listed = await listOwnedFiles(root);
  if (!listed.ok) return { ...decideCompact({ files: 0, logical: null, allocated: null, wof: null }), reason: listed.reason };
  if (process.platform !== "win32") {
    return decideCompact({ files: listed.files.length, logical: null, allocated: null, wof: null });
  }
  const [sizes, query] = await Promise.all([
    compressedSizes(listed.files.map((file) => file.full)),
    compactQuery(root),
  ]);
  const account = finishMeasurement({
    files: listed.files,
    markerBytes: listed.markerBytes,
    markerFiles: listed.markerFiles,
    sizes,
    queryText: query.text,
    queryOk: query.ok,
    queryNote: query.note,
  });
  if (!options?.debugProbe) return account;
  return { ...account, probe: sizes.probe };
}

export function finishMeasurement(input: {
  files: readonly OwnedFile[];
  markerBytes: number;
  markerFiles: number;
  sizes: { ok: boolean; values: ReadonlyMap<string, number | null>; states: ReadonlyMap<string, WofState>; note: string };
  queryText: string;
  queryOk: boolean;
  queryNote: string;
}): CompactAccount {
  const account = reconcileOwnedRoot({
    files: input.files,
    sizes: input.sizes.values,
    wofState: input.sizes.states,
    summary: parseCompactSummary(input.queryText),
    perFile: parseCompactListing(input.queryText),
    markerBytes: input.markerBytes,
    markerFiles: input.markerFiles,
  });
  const extra = [
    input.sizes.ok ? "" : userFacingDiag(input.sizes.note),
    input.queryOk ? "" : userFacingDiag(input.queryNote || "compact /Q не прочитан"),
  ].filter(Boolean);
  const reason = stripPowerShellNoise([account.reason, ...extra].filter(Boolean).join(" "));
  if (!account.known && !input.sizes.ok) {
    return { ...account, reason: stripPowerShellNoise(["Измерение корня не сошлось. Сжатие заново не запускается.", reason].filter(Boolean).join(" ")) };
  }
  return { ...account, reason };
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

/** UTF-16LE base64 for powershell.exe -EncodedCommand. Avoids -Command quote stripping and newline splitting. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function powershellProbeArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellCommand(script)];
}

export function measureDebugRequested(args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): boolean {
  return args.includes("--debug-probe") || env.SKLAD_COMPACT_DEBUG === "1";
}

/** UTF-8 JSON array. One element per file, so spaces, quotes and Cyrillic stay inside the string. */
export function serializeProbePaths(files: readonly string[]): string {
  return JSON.stringify(files);
}

/**
 * Same branch as the PowerShell probe: a JSON array is one path per element.
 * A single JSON string stays one path. The array is never joined with a space.
 */
export function enumerateProbePaths(parsed: unknown): string[] {
  if (typeof parsed === "string") return parsed.length > 0 ? [parsed] : [];
  if (!Array.isArray(parsed)) return [];
  const paths: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string" || item.length === 0) return [];
    paths.push(item);
  }
  return paths;
}

/** Shown only for `game measure --debug-probe` or SKLAD_COMPACT_DEBUG=1. */
export interface ProbeDiagnostic {
  exitCode: number | null;
  stdoutBytes: number;
  stdoutPreview: string;
  stderrBytes: number;
  stderr: string;
  powershell: string;
  argv: string[];
  script: string;
  rows: number;
}

export function buildProbeReport(input: {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  stderrBytes: number;
  powershell: string;
  argv: string[];
  script: string;
  rows: number;
}): ProbeDiagnostic {
  const preview = stripPowerShellNoise(probeText(input.stdout)).replace(/\s+/g, " ").trim().slice(0, 400);
  return {
    exitCode: input.exitCode,
    stdoutBytes: input.stdout.length,
    stdoutPreview: preview,
    stderrBytes: input.stderrBytes,
    stderr: userFacingDiag(input.stderr),
    powershell: input.powershell,
    argv: input.argv,
    script: input.script,
    rows: input.rows,
  };
}

/** PowerShell probe. Size and WOF are separate types so a WOF compile failure still returns allocated bytes. */
export function compressionProbeScript(): string {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
try { $OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
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
if ([string]::IsNullOrEmpty($env:SKLAD_COMPACT_LIST)) { [Console]::Error.WriteLine('SKLAD_COMPACT_LIST empty'); exit 1 }
$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $utf8 } catch {}
$raw = [System.IO.File]::ReadAllText($env:SKLAD_COMPACT_LIST, $utf8)
$parsed = ConvertFrom-Json -InputObject $raw
$paths = New-Object System.Collections.Generic.List[string]
if ($parsed -is [System.Array]) {
  foreach ($entry in $parsed) { [void]$paths.Add([string]$entry) }
} else {
  [void]$paths.Add([string]$parsed)
}
$index = 0
$lines = New-Object System.Collections.Generic.List[string]
foreach ($full in $paths) {
  $size = [SkladSize]::Of($full)
  $code = -1
  if ($wofReady) {
    try { $code = [SkladWof]::State($full) } catch { $code = -1 }
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
  $allocJson = 'null'
  if ($null -ne $alloc) { $allocJson = [string]$alloc }
  $wofJson = 'null'
  if ($null -ne $wof) { $wofJson = [string]$wof }
  $algJson = 'null'
  if ($null -ne $alg) { $algJson = '"' + $alg + '"' }
  $line = '{"index":' + $index + ',"allocated":' + $allocJson + ',"wof":' + $wofJson + ',"algorithm":' + $algJson + '}'
  [void]$lines.Add($line)
  Write-Output $line
  $index++
}
if (-not [string]::IsNullOrEmpty($env:SKLAD_COMPACT_OUT)) {
  [System.IO.File]::WriteAllText($env:SKLAD_COMPACT_OUT, ('[' + ($lines -join ',') + ']'), $utf8)
}
`.trim();
}

async function compressedSizes(files: readonly string[]): Promise<{ ok: boolean; values: Map<string, number | null>; states: Map<string, WofState>; total: number | null; code: number | null; note: string; probe: ProbeDiagnostic }> {
  const empty = new Map<string, number | null>();
  const states = new Map<string, WofState>();
  const script = compressionProbeScript();
  const bin = await resolveWindowsPowershell();
  const argv = powershellProbeArgs(script);
  if (files.length === 0) {
    return { ok: true, values: empty, states, total: 0, code: 0, note: "", probe: buildProbeReport({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "", stderrBytes: 0, powershell: bin, argv, script, rows: 0 }) };
  }
  const listDir = await mkdtemp(path.join(tmpdir(), "sklad-compact-"));
  const listFile = path.join(listDir, "files.json");
  const outFile = path.join(listDir, "result.json");
  let result: Awaited<ReturnType<typeof run>>;
  let resultText = "";
  try {
    await writeFile(listFile, serializeProbePaths(files), "utf8");
    result = await run(bin, argv, { SKLAD_COMPACT_LIST: listFile, SKLAD_COMPACT_OUT: outFile });
    try {
      resultText = await readFile(outFile, "utf8");
    } catch {
      resultText = "";
    }
  } finally {
    await rm(listDir, { recursive: true, force: true });
  }
  const parsed = parseSizeProbeOutput(resultText ? Buffer.from(resultText, "utf8") : result.stdoutBuf);
  const bound = bindProbeRows(files, parsed.rows);
  const values = bound.values;
  for (const [file, state] of bound.states) states.set(file, state);
  const numbers = files.map((file) => values.get(file) ?? null);
  const complete = numbers.every((value) => value != null);
  const total = complete ? numbers.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const probe = buildProbeReport({
    exitCode: result.code,
    stdout: result.stdoutBuf,
    stderr: result.stderr || result.error,
    stderrBytes: result.stderrBuf.length,
    powershell: bin,
    argv,
    script,
    rows: parsed.rows.length,
  });
  if (complete) return { ok: true, values, states, total, code: result.code, note: "", probe };
  return { ok: false, values, states, total, code: result.code, note: "GetCompressedFileSizeW не вернул размер каждого файла корня.", probe };
}

export interface ProbeRow {
  index: number | null;
  path: string;
  allocated: number | null;
  wof: number | null;
  algorithm: WofAlgorithm | null;
}

/** Index wins. A mojibake path from the console code page is not used for lookup. */
export function bindProbeRows(files: readonly string[], rows: readonly ProbeRow[]): { values: Map<string, number | null>; states: Map<string, WofState> } {
  const values = new Map<string, number | null>();
  const states = new Map<string, WofState>();
  for (const row of rows) {
    const file = row.index != null ? files[row.index] : row.path;
    if (!file) continue;
    values.set(file, row.allocated);
    states.set(file, { wof: row.wof, algorithm: row.algorithm });
  }
  return { values, states };
}

export function parseSizeProbeOutput(buf: Buffer): { ok: boolean; note: string; rows: ProbeRow[] } {
  const rows: ProbeRow[] = [];
  const text = probeText(buf);
  for (const chunk of parsedRows(text)) {
    try {
      const parsed = JSON.parse(chunk) as { index?: number; path?: string; allocated?: number | null; wof?: number | null; algorithm?: string | null };
      const index = typeof parsed.index === "number" && Number.isInteger(parsed.index) && parsed.index >= 0 ? parsed.index : null;
      const pathText = typeof parsed.path === "string" ? parsed.path : "";
      if (index == null && !pathText) continue;
      const allocated = typeof parsed.allocated === "number" && Number.isSafeInteger(parsed.allocated) && parsed.allocated >= 0 ? parsed.allocated : null;
      const wof = typeof parsed.wof === "number" && Number.isSafeInteger(parsed.wof) && parsed.wof >= 0 ? parsed.wof : null;
      const algorithm = typeof parsed.algorithm === "string" && WOF_ALGORITHM.test(parsed.algorithm) ? parsed.algorithm.toUpperCase() as WofAlgorithm : null;
      rows.push({ index, path: pathText, allocated, wof, algorithm });
    } catch {
      continue;
    }
  }
  if (rows.length === 0) return { ok: false, note: "GetCompressedFileSizeW не вернул ни одной строки.", rows };
  return { ok: true, note: "", rows };
}

/** Windows PowerShell 5.1 Write-Output to a pipe is often UTF-16LE. Pick the decode that yields JSON rows. */
function probeText(buf: Buffer): string {
  if (buf.length === 0) return "";
  const utf16 = buf.toString("utf16le").replace(/^\uFEFF/, "");
  const utf8 = buf.toString("utf8").replace(/^\uFEFF/, "");
  return parsedRows(utf16).length >= parsedRows(utf8).length ? utf16 : utf8;
}

function parsedRows(text: string): string[] {
  return jsonObjects(text).filter((chunk) => {
    try {
      const parsed = JSON.parse(chunk) as { path?: unknown; index?: unknown };
      const hasIndex = typeof parsed.index === "number" && Number.isInteger(parsed.index) && parsed.index >= 0;
      return hasIndex || (typeof parsed.path === "string" && parsed.path.length > 0);
    } catch {
      return false;
    }
  });
}

function jsonObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return found;
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

/** Drops PowerShell progress CLIXML. The raw stream is not a user-facing reason. */
export function stripPowerShellNoise(text: string): string {
  return text
    .replace(/#<\s*CLIXML[\s\S]*$/gi, "")
    .replace(/<Objs[\s\S]*$/gi, "")
    .replace(/\u0000/g, "")
    .trim();
}

export function userFacingDiag(text: string): string {
  const clean = stripPowerShellNoise(text);
  if (!clean) return "";
  if (/CLIXML/i.test(clean) || /S="progress"/i.test(clean)) return "";
  return clipDiag(clean);
}

export function clipDiag(text: string): string {
  return stripPowerShellNoise(text)
    .replace(/\uFEFF/g, "")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\/(?:Users|home)\/[^\s"']+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function run(bin: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stdoutBuf: Buffer; stderr: string; stderrBuf: Buffer; error: string }> {
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
    child.on("error", (error) => resolve({ code: null, stdout: "", stdoutBuf: Buffer.alloc(0), stderr: "", stderrBuf: Buffer.alloc(0), error: error.message }));
    child.on("close", (code) => {
      const stdoutBuf = Buffer.concat(out);
      const stderrBuf = Buffer.concat(err);
      resolve({ code, stdout: decodeProcessText(stdoutBuf), stdoutBuf, stderr: decodeProcessText(stderrBuf), stderrBuf, error: "" });
    });
  });
}
