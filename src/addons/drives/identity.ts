import { createHash, randomUUID } from "node:crypto";

const UUID_RE = /[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/;

export function normalizeSerial(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
}

export function normalizeUuid(value: string | null | undefined): string {
  const match = String(value ?? "").match(UUID_RE);
  if (!match) return "";
  return match[0].replace(/-/g, "").toLowerCase();
}

export function formatUuid(norm: string): string {
  if (norm.length !== 32) return norm;
  return `${norm.slice(0, 8)}-${norm.slice(8, 12)}-${norm.slice(12, 16)}-${norm.slice(16, 20)}-${norm.slice(20)}`;
}

/** Same physical volume only when both serial and UUID are present and equal. */
export function identityKey(serial: string | null | undefined, volumeUuid: string | null | undefined): string | null {
  const serialNorm = normalizeSerial(serial);
  const uuidNorm = normalizeUuid(volumeUuid);
  if (!serialNorm || !uuidNorm) return null;
  return `${serialNorm}|${uuidNorm}`;
}

export function stableDiskId(serial: string, volumeUuid: string): string {
  const uuidNorm = normalizeUuid(volumeUuid);
  if (!uuidNorm) return `disk-${randomUUID()}`;
  // Serial keeps the historical Windows id. A volume that has only a UUID still gets one stable id.
  const serialNorm = normalizeSerial(serial);
  const key = serialNorm ? `${serialNorm}|${uuidNorm}` : `uuid|${uuidNorm}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 20);
  return `disk-${hash}`;
}

export function anonymousDiskId(): string {
  return `disk-${randomUUID()}`;
}
