import { formatBytes } from "@/lib/format";
import type { MediaProfile } from "@/lib/optical/media";

/**
 * CD check is 700 MiB.
 * 650 MiB is the older CD-R size and is not used for the check.
 */
export const CD_BYTES = 700 * 1024 * 1024;

/** Official DVD-R single-layer size: 2_295_104 sectors × 2048 bytes. */
export const DVD_SL_BYTES = 4_700_372_992;

/** DVD±R dual-layer size used by this check: 8.5 GB. */
export const DVD_DL_BYTES = 8_543_666_176;

/** BD-R single layer: 12_219_392 sectors × 2048 bytes (25 GB). */
export const BD_SL_BYTES = 12_219_392 * 2048;

/** BD-R dual layer: twice the single-layer sector count. */
export const BD_DL_BYTES = 24_438_784 * 2048;

export const PROFILE_BYTES: Record<MediaProfile, number> = {
  cd: CD_BYTES,
  "dvd-sl": DVD_SL_BYTES,
  "dvd-dl": DVD_DL_BYTES,
  "bd-sl": BD_SL_BYTES,
  "bd-dl": BD_DL_BYTES,
};

export const PROFILE_NAME: Record<MediaProfile, string> = {
  cd: "CD (700 МиБ)",
  "dvd-sl": "DVD±R/RW (4,7 ГБ)",
  "dvd-dl": "DVD±R DL (8,5 ГБ)",
  "bd-sl": "BD-R (25 ГБ)",
  "bd-dl": "BD-R DL (50 ГБ)",
};

export function capacityOf(profile: MediaProfile): number {
  return PROFILE_BYTES[profile];
}

export function treeBytes(files: { size: number }[]): number {
  return files.reduce((sum, file) => sum + (Number.isFinite(file.size) ? Math.max(0, file.size) : 0), 0);
}

export type CapacityResult = { ok: true; limit: number } | { ok: false; limit: number; reason: string };

/** Pure check. Rejects only when the tree is strictly larger than the profile. */
export function checkCapacity(bytes: number, profile: MediaProfile): CapacityResult {
  const limit = capacityOf(profile);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return { ok: false, limit, reason: "Размер выбранных файлов не удалось посчитать." };
  }
  if (bytes > limit) {
    return {
      ok: false,
      limit,
      reason: `Не влезает на ${PROFILE_NAME[profile]}: выбрано ${formatBytes(bytes)}, предел ${limit.toLocaleString("ru-RU")} байт.`,
    };
  }
  return { ok: true, limit };
}
