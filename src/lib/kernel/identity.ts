import { SkladError } from "@/lib/kernel/errors";

export interface IdentityRecord {
  id: string;
  serial: string;
  volumeUuid: string;
}

export interface IdentityProbe {
  serial: string;
  volumeUuid: string;
}

export type IdentityMatch =
  | { kind: "same"; diskId: string }
  | { kind: "clone"; diskId: string }
  | { kind: "new"; diskId: null };

/** Letters, punctuation and braces are not part of identity. */
export function normalizeSerial(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeVolumeUuid(value: string): string {
  return value.trim().toLowerCase().replace(/[{}]/g, "");
}

/**
 * Match only serial + volume UUID.
 * The mount point and drive letter are intentionally not parameters.
 * Same UUID with another serial is a clone: the caller must not merge records.
 */
export function matchDisk(existing: IdentityRecord[], probe: IdentityProbe): IdentityMatch {
  const serial = normalizeSerial(probe.serial);
  const volumeUuid = normalizeVolumeUuid(probe.volumeUuid);
  if (!serial || !volumeUuid) {
    throw new SkladError(
      "validation",
      "Нужны серийный номер и UUID тома. Буква диска и точка монтирования диск не определяют.",
    );
  }
  const same = existing.find(
    (disk) => normalizeSerial(disk.serial) === serial && normalizeVolumeUuid(disk.volumeUuid) === volumeUuid,
  );
  if (same) return { kind: "same", diskId: same.id };
  const clone = existing.find((disk) => normalizeVolumeUuid(disk.volumeUuid) === volumeUuid);
  if (clone) return { kind: "clone", diskId: clone.id };
  return { kind: "new", diskId: null };
}
