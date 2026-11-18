import { isZMount } from "@/addons/drives/transfer/paths";

/** E: and Z: are never read, scanned, indexed, copied, or logged. */
export function isSkippedVolume(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (isZMount(text)) return true;
  const win = text.replace(/\//g, "\\");
  if (/^[ez]:\\/i.test(win) || /^[ez]:$/i.test(win)) return true;
  if (/^\/mnt\/[ez](\/|$)/i.test(text)) return true;
  return /(^|[\\/])[ez]:([\\/]|$)/i.test(text);
}

export function skippedVolumeNote(value: string | null | undefined): string {
  const text = String(value ?? "");
  if (/(^|[\\/])e:([\\/]|$)/i.test(text) || /^e:/i.test(text) || /^\/mnt\/e(\/|$)/i.test(text)) return "Диск E: пропущен.";
  return "Диск Z: пропущен.";
}

/** A path this process could open. Windows letters are not local on macOS or Linux. */
export function mightBeLocal(filePath: string): boolean {
  if (!filePath || isSkippedVolume(filePath)) return false;
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return process.platform === "win32";
  return filePath.startsWith("/");
}
