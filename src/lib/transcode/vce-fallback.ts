import type { EncodeCodec } from "@/lib/transcode/assign";

/** Windows STATUS_ACCESS_VIOLATION, the code from the RX 9070 XT vce_av1 smoke. */
export const VCE_AV1_CRASH = 3221225477;
/** Same code when a runtime reports it as a signed 32-bit status. */
export const VCE_AV1_CRASH_SIGNED = -1073741819;

const BROKEN_AV1 = new Set(["vce_av1", "vce_av1_10bit"]);

export function isNativeEncodeCrash(code: number | null): boolean {
  return code === VCE_AV1_CRASH || code === VCE_AV1_CRASH_SIGNED || code === 139;
}

/** AV1 stays AV1. The crashing VCE names are never returned. */
export function softwareAv1(encoders: readonly string[], hdr: boolean): string | null {
  if (hdr) return encoders.includes("svt_av1_10bit") ? "svt_av1_10bit" : null;
  return encoders.includes("svt_av1") ? "svt_av1" : null;
}

export function av1UsesSoftwareFallback(encoders: readonly string[]): boolean {
  return encoders.some((name) => BROKEN_AV1.has(name));
}

/** Hardware-only AV1 still falls back to SVT when the only hardware name is the known VCE crash. */
export function routeAv1(input: { allowSoftware: boolean; encoders: readonly string[] }): { allowSoftware: boolean; fallback: boolean; block: boolean } {
  const broken = av1UsesSoftwareFallback(input.encoders);
  const software = Boolean(softwareAv1(input.encoders, false) || softwareAv1(input.encoders, true));
  if (!broken) return { allowSoftware: input.allowSoftware, fallback: false, block: false };
  if (software) return { allowSoftware: true, fallback: true, block: false };
  return { allowSoftware: false, fallback: false, block: !input.allowSoftware };
}

/**
 * After a native crash: discard the partial, retry software AV1 once if the
 * attempt really was vce_av1, and never touch the source. A software crash does not retry.
 */
export function afterHardwareCrash(input: {
  code: number | null;
  encoder: string;
  retried: boolean;
  encoders: readonly string[];
  hdr: boolean;
  codec: EncodeCodec;
}): { retry: boolean; encoder: string | null; discardPartial: true; touchSource: false } {
  const stop = { retry: false, encoder: null, discardPartial: true as const, touchSource: false as const };
  if (!isNativeEncodeCrash(input.code) || input.codec !== "av1" || input.retried || !BROKEN_AV1.has(input.encoder)) return stop;
  const next = softwareAv1(input.encoders, input.hdr);
  if (!next) return stop;
  return { retry: true, encoder: next, discardPartial: true, touchSource: false };
}
