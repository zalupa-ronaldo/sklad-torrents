/** Windows Z: and its WSL mount. Never read, write, list, or log that volume. */
export function isZMount(mount: string): boolean {
  const text = mount.trim();
  return /^z:\\/i.test(text) || /^z:$/i.test(text);
}

export function isForbiddenMount(mountOrPath: string): boolean {
  const value = String(mountOrPath || "").trim();
  if (!value) return false;
  const windows = value.replace(/\//g, "\\");
  if (isZMount(value) || isZMount(windows)) return true;
  if (/^z:[\\/]/i.test(value)) return true;
  if (/^\\\\[.?]\\z:/i.test(value)) return true;
  if (/^\/mnt\/z(\/|$)/i.test(value)) return true;
  return false;
}

export function diskTouchesForbiddenZ(disk: {
  lastMountPath?: string;
  priorMountPath?: string;
  mountPaths?: string[];
}): boolean {
  const mounts = [disk.lastMountPath, disk.priorMountPath, ...(disk.mountPaths ?? [])];
  return mounts.some((mount) => typeof mount === "string" && mount.length > 0 && isForbiddenMount(mount));
}
