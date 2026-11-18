import { OpticalError } from "@/lib/optical/errors";

/** E: and Z: are never read. F: is the virtual Alcohol device and is not a file source. */
export function isForbiddenVolumePath(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  const stripped = text.replace(/^\\\\\?\\/, "");
  if (/^[ez]:/i.test(stripped)) return true;
  if (/^\/mnt\/[ez](\/|$)/i.test(stripped)) return true;
  return false;
}

export function assertOpticalPath(value: string): void {
  if (!isForbiddenVolumePath(value)) return;
  const letter = /^[eE]/.test(value.trim().replace(/^\\\\\?\\/, "")) || /^\/mnt\/e/i.test(value) ? "E" : "Z";
  throw new OpticalError("forbidden", letter === "E" ? "Диск E: не используется." : "Диск Z: не используется.");
}
