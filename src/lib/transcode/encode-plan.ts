import path from "node:path";

import type { EncodeCodec } from "@/lib/transcode/assign";

export const ENCODE_LIMITS = {
  maxSourceBytes: 32 * 1024 * 1024,
  timeoutMs: 60_000,
  /** Output must fit beside the source. This is not a configured disk reserve. */
  scratchFactor: 3,
  floorFreeBytes: 64 * 1024 * 1024,
} as const;

export const CONSERVATIVE_PRESET = {
  id: "conservative",
  configured: true,
  label: "Настроенный консервативный пресет. Это не Fast 1080p30 и не молчаливый H.264.",
  quality: { av1: 32, hevc: 22, h264: 20 },
} as const;

export interface MediaFacts {
  format: string;
  duration: number | null;
  videoCodec: string | null;
  audio: number;
  subtitles: number;
  chapters: number;
  hdr: boolean;
}

export interface HandBrakeCapability {
  present: boolean;
  version: string | null;
  encoders: string[];
  audioCopy: boolean;
  markers: boolean;
  subtitles: boolean;
  /** Functional hardware encode. Help text never sets this. */
  hardwareAv1: boolean;
  /** vce_av1 names present in help. Not a functional pass, and vt_av1 is not one of them. */
  advertisedHardwareAv1: string[];
}

const HDR_TRANSFER = new Set(["smpte2084", "arib-std-b67"]);

export function windowsVolumeLetter(filePath: string): string | null {
  const text = filePath.trim();
  const match = /^(?:\\\\\?\\)?([A-Za-z]):[\\/]/.exec(text);
  return match ? match[1]!.toUpperCase() : null;
}

/** Refuse E: and Z: before any file call. A Linux path has no such letter. */
export function assertEncodePaths(paths: readonly string[]): void {
  for (const filePath of paths) {
    if (!filePath || filePath.includes("\0")) throw new Error("Пустой путь или NUL в пути.");
    if (filePath.startsWith("/dev/") || filePath.startsWith("\\\\.\\") || filePath.startsWith("//./")) {
      throw new Error("Нужен файл, не устройство.");
    }
    const letter = windowsVolumeLetter(filePath);
    if (letter === "E" || letter === "Z") {
      throw new Error("E и Z не открываются: ни источник, ни назначение, ни staging, ни возврат.");
    }
  }
}

export function encodersFromHelp(help: string): string[] {
  const start = help.indexOf("Select video encoder:");
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of help.slice(start).split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("-") || /\s/.test(trimmed)) break;
    names.push(trimmed);
  }
  return names;
}

export function versionFromText(text: string): string | null {
  const match = /HandBrake\s+(\d+\.\d+\.\d+)/.exec(text);
  return match ? match[1]! : null;
}

/** Names seen in HandBrake 1.11.1 help. Presence is not a functional hardware encode. */
export const ADVERTISED_VCE_AV1 = ["vce_av1", "vce_av1_10bit"] as const;

export function capabilityFromHelp(help: string, versionText: string): HandBrakeCapability {
  const encoders = encodersFromHelp(help);
  const advertisedHardwareAv1 = encoders.filter((name) => (ADVERTISED_VCE_AV1 as readonly string[]).includes(name));
  return {
    present: encoders.length > 0,
    version: versionFromText(versionText) ?? versionFromText(help),
    encoders,
    audioCopy: /^\s+copy\s*$/m.test(help),
    markers: help.includes("--markers"),
    subtitles: help.includes("--subtitle"),
    hardwareAv1: false,
    advertisedHardwareAv1,
  };
}

export function mediaFromProbe(payload: unknown): MediaFacts {
  const raw = payload as { format?: { format_name?: string; duration?: string }; streams?: unknown[]; chapters?: unknown[] };
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  let videoCodec: string | null = null;
  let audio = 0;
  let subtitles = 0;
  let hdr = false;
  for (const item of streams) {
    if (!item || typeof item !== "object") continue;
    const stream = item as { codec_type?: string; codec_name?: string; color_transfer?: string; side_data_list?: { side_data_type?: string }[] };
    if (stream.codec_type === "video") {
      videoCodec = videoCodec ?? stream.codec_name ?? null;
      if (stream.color_transfer && HDR_TRANSFER.has(stream.color_transfer)) hdr = true;
      if (stream.side_data_list?.some((side) => /HDR|DOVI|dovi/i.test(side.side_data_type ?? ""))) hdr = true;
    } else if (stream.codec_type === "audio") audio += 1;
    else if (stream.codec_type === "subtitle") subtitles += 1;
  }
  const duration = Number(raw.format?.duration);
  return {
    format: raw.format?.format_name ?? "",
    duration: Number.isFinite(duration) ? duration : null,
    videoCodec,
    audio,
    subtitles,
    chapters: Array.isArray(raw.chapters) ? raw.chapters.length : 0,
    hdr,
  };
}

export function requirementBlock(source: MediaFacts, capability: HandBrakeCapability, codec: EncodeCodec): string | null {
  if (source.audio > 0 && !capability.audioCopy) {
    return "В источнике есть звук, а копирование дорожки этот HandBrake не подтвердил. Перекодирование звука без согласия не начинается.";
  }
  if (source.subtitles > 0 && !capability.subtitles) {
    return "В источнике есть субтитры, а их сохранение не подтверждено. Задание блокируется.";
  }
  if (source.chapters > 0 && !capability.markers) {
    return "В источнике есть главы, а --markers у этого HandBrake нет. Задание блокируется.";
  }
  if (source.hdr) {
    const tenBit = codec === "av1" ? "svt_av1_10bit" : codec === "hevc" ? "x265_10bit" : null;
    if (!tenBit || !capability.encoders.includes(tenBit)) {
      return "В источнике HDR. Выбранный кодек в 10-битном виде здесь нет, и подмена на другой кодек не делается.";
    }
  }
  return null;
}

/** Observed on the Windows 1.11.1 smoke. The log does not name an AMF error code or a driver. */
export const VCE_AV1_SMOKE = {
  code: 3221225477,
  geometry: "160x120",
  quality: 30,
  mux: "mkv",
} as const;

export function advertisedHardwareBlock(encoders: readonly string[]): string | null {
  const names = encoders.filter((name) => (ADVERTISED_VCE_AV1 as readonly string[]).includes(name));
  if (names.length === 0) return null;
  return `В справке есть ${names.join(", ")}. Это не рабочий прогон. Прямой vce_av1 HandBrake 1.11.1 на ролике ${VCE_AV1_SMOKE.geometry}, CQ ${VCE_AV1_SMOKE.quality}, mux ${VCE_AV1_SMOKE.mux} завершился кодом ${VCE_AV1_SMOKE.code} на encavcodecInit: AV1 (AMD VCE). stdout пустой, исходник не изменился, HEVC и svt_av1 не подставлялись. Причина AMF этим логом не установлена. Автоповтор выключен.`;
}

export type OutputContainer = "mp4" | "mkv";

export function containerFromPath(file: string): OutputContainer | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "mp4";
  if (ext === ".mkv") return "mkv";
  return null;
}

export function handbrakeMux(container: OutputContainer): "av_mp4" | "av_mkv" {
  return container === "mkv" ? "av_mkv" : "av_mp4";
}

export function formatMatchesContainer(formatName: string, container: OutputContainer): boolean {
  const parts = formatName.toLowerCase().split(",").map((part) => part.trim());
  if (container === "mkv") return parts.some((part) => part === "matroska" || part === "mkv");
  return parts.some((part) => part === "mp4" || part === "mov" || part === "m4v");
}

export function videoEncoder(codec: EncodeCodec, hdr: boolean, encoders: readonly string[]): string | null {
  if (codec === "av1") {
    if (hdr) return encoders.includes("svt_av1_10bit") ? "svt_av1_10bit" : null;
    return encoders.includes("svt_av1") ? "svt_av1" : null;
  }
  if (codec === "hevc") {
    if (hdr) return encoders.includes("x265_10bit") ? "x265_10bit" : null;
    return encoders.includes("x265") ? "x265" : null;
  }
  if (hdr) return null;
  return encoders.includes("x264") ? "x264" : null;
}

export function encodeArgv(input: {
  binary: string;
  source: string;
  output: string;
  codec: EncodeCodec;
  container: OutputContainer;
  sourceFacts: MediaFacts;
  encoders: readonly string[];
}): string[] {
  const encoder = videoEncoder(input.codec, input.sourceFacts.hdr, input.encoders);
  if (!encoder) throw new Error("Нет кодировщика запрошенного кодека. Другой кодек не подставляется.");
  if (input.codec === "av1" && !encoder.startsWith("svt_av1")) {
    throw new Error("AV1 не подменяется другим кодеком.");
  }
  if (/^vce_/.test(encoder)) throw new Error(advertisedHardwareBlock([encoder]) || "Аппаратный кодировщик VCE автоматически не запускается.");
  const quality = String(CONSERVATIVE_PRESET.quality[input.codec]);
  const args = [
    input.binary,
    "--json",
    "--min-duration",
    "0",
    "-i",
    input.source,
    "-o",
    input.output,
    "-e",
    encoder,
    "-q",
    quality,
    "-f",
    handbrakeMux(input.container),
    "--all-audio",
    "-E",
    "copy",
    "--audio-fallback",
    "none",
    "--markers",
  ];
  if (encoder.startsWith("svt_av1")) args.push("--encoder-preset", "8");
  if (input.sourceFacts.subtitles > 0) {
    const indexes = Array.from({ length: input.sourceFacts.subtitles }, (_, index) => String(index + 1)).join(",");
    args.push("-s", indexes, "--subtitle-burned", "none");
  }
  return args;
}

export function durationClose(source: number | null, output: number | null): boolean {
  if (source == null || output == null || source <= 0 || output <= 0) return false;
  const delta = Math.abs(source - output);
  return delta <= 0.35 || delta / source <= 0.15;
}

export function codecFamily(name: string | null): EncodeCodec | null {
  if (!name) return null;
  const text = name.toLowerCase();
  if (text.includes("av1")) return "av1";
  if (text.includes("hevc") || text.includes("265")) return "hevc";
  if (text.includes("264") || text === "h264") return "h264";
  return null;
}

export function verifyMedia(input: {
  codec: EncodeCodec;
  container: OutputContainer;
  source: MediaFacts;
  output: MediaFacts;
  decodeOk: boolean;
  exitCode: number | null;
}): {
  containerOk: boolean;
  decodeOk: boolean;
  durationOk: boolean;
  tracksOk: boolean;
  presetAccepted: boolean;
  verified: boolean;
} {
  const containerOk = formatMatchesContainer(input.output.format, input.container);
  const durationOk = durationClose(input.source.duration, input.output.duration);
  const tracksOk = input.output.audio >= input.source.audio && input.output.subtitles >= input.source.subtitles;
  const presetAccepted = input.exitCode === 0 && codecFamily(input.output.videoCodec) === input.codec && containerOk && input.decodeOk && durationOk && tracksOk;
  return {
    containerOk,
    decodeOk: input.decodeOk,
    durationOk,
    tracksOk,
    presetAccepted,
    verified: presetAccepted,
  };
}

export function pathInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const file = path.resolve(target);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return file.startsWith(prefix);
}

export function scratchFits(freeBytes: number | null, sourceBytes: number): { ok: boolean; reason: string | null } {
  if (freeBytes == null || !Number.isFinite(freeBytes)) {
    return { ok: false, reason: "Свободное место на scratch не прочитано. Кодирование не начинается." };
  }
  const needed = sourceBytes * ENCODE_LIMITS.scratchFactor + ENCODE_LIMITS.floorFreeBytes;
  if (freeBytes < needed) {
    return { ok: false, reason: "На scratch мало места для временного файла. Это не подтверждённый резерв 50 или 100 ГБ." };
  }
  return { ok: true, reason: null };
}
