import type { EnqueueInput, JobHost } from "@/lib/jobs/model";

import { ignoredVolumeDetail, isIgnoredVolume, machineOfPath } from "@/lib/progress/paths";

export type PlaceResult =
  | { ok: true; input: EnqueueInput; notice: string | null }
  | { ok: false; error: string };

const MAC_NOTICE = "Файл лежит на Mac. Очередь отдала его Mac (Apple VideoToolbox) и не копирует его по сети.";
const PC_NOTICE = "Файл лежит на ПК. Очередь отдала его ПК (AMD RX 9070 XT, VCE/AMF) и не копирует его по сети.";

/**
 * HandBrake stays on the machine that already has the file.
 * A different machine needs a separate SHA-256 copy. This function does not copy or delete anything.
 */
export function placeTranscode(input: EnqueueInput): PlaceResult {
  if (input.kind !== "transcode") return { ok: true, input, notice: null };
  const source = input.source ?? "";
  const destination = input.destination ?? "";
  if (isIgnoredVolume(source) || isIgnoredVolume(destination)) return { ok: false, error: ignoredVolumeDetail(isIgnoredVolume(source) ? source : destination) };
  const owner = machineOfPath(source);
  if (!owner) return { ok: true, input, notice: null };
  const notice = owner === "mac-local" ? MAC_NOTICE : PC_NOTICE;
  if (input.host === owner) return { ok: true, input, notice };
  const next: EnqueueInput = { ...input, host: owner satisfies JobHost };
  return { ok: true, input: next, notice: `${notice} Чтобы кодировать на другой машине, сначала сделайте копию с SHA-256. Оригинал не удаляется.` };
}
