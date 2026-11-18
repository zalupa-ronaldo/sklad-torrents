/** Windows Z: and its WSL mount. Never read, write, list, or log that volume. */
export function isZMount(mount: string): boolean {
  const text = mount.trim();
  return /^z:\\/i.test(text) || /^z:$/i.test(text);
}

/** Live E: is the unhealthy disk. Same closed set as Z: for copies and opens. */
export function isForbiddenLiveLetter(mount: string): boolean {
  const text = mount.trim();
  return /^[ez]:\\/i.test(text) || /^[ez]:$/i.test(text);
}

export function isForbiddenMount(mountOrPath: string): boolean {
  const value = String(mountOrPath || "").trim();
  if (!value) return false;
  const windows = value.replace(/\//g, "\\");
  if (isForbiddenLiveLetter(value) || isForbiddenLiveLetter(windows)) return true;
  if (/^[ez]:[\\/]/i.test(value)) return true;
  if (/^\\\\[.?]\\[ez]:/i.test(value)) return true;
  if (/^\/mnt\/[ez](\/|$)/i.test(value)) return true;
  if (isVirtualAlcoholTransfer(value) || isVirtualAlcoholTransfer(windows)) return true;
  return false;
}

/** F: is the virtual Alcohol drive. It is not a copy source or destination. */
function isVirtualAlcoholTransfer(mount: string): boolean {
  const text = mount.trim();
  return /^f:\\/i.test(text) || /^f:$/i.test(text) || /^\\\\[.?]\\f:/i.test(text) || /^\/mnt\/f(\/|$)/i.test(text);
}

export function diskTouchesForbiddenZ(disk: {
  lastMountPath?: string;
  priorMountPath?: string;
  mountPaths?: string[];
}): boolean {
  const mounts = [disk.lastMountPath, disk.priorMountPath, ...(disk.mountPaths ?? [])];
  return mounts.some((mount) => typeof mount === "string" && mount.length > 0 && isForbiddenMount(mount));
}
