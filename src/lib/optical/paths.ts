import { OpticalError } from "@/lib/optical/errors";

/** True for the Windows volume the product must never read, list, or show. */
export function isForbiddenVolumePath(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  const stripped = text.replace(/^\\\\\?\\/, "");
  if (/^z:/i.test(stripped)) return true;
  if (/^\/mnt\/z(\/|$)/i.test(stripped)) return true;
  return false;
}

export function assertOpticalPath(value: string): void {
  if (isForbiddenVolumePath(value)) {
    throw new OpticalError("forbidden", "Диск Z: не используется.");
  }
}
