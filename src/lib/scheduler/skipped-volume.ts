import { isZMount } from "@/addons/drives/transfer/paths";

/** Z: is never read, scanned, indexed, copied, or logged. */
export function isSkippedVolume(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (isZMount(text)) return true;
  const win = text.replace(/\//g, "\\");
  if (/^z:\\/i.test(win) || /^z:$/i.test(win)) return true;
  return /(^|[\\/])z:([\\/]|$)/i.test(text);
}

/** A path this process could open. Windows letters are not local on macOS or Linux. */
export function mightBeLocal(filePath: string): boolean {
  if (!filePath || isSkippedVolume(filePath)) return false;
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return process.platform === "win32";
  return filePath.startsWith("/");
}
