const UNKNOWN_ETA = 8_640_000;

export function bytesPerSecond(bytesDone: number, elapsedMs: number): number {
  if (!Number.isFinite(bytesDone) || bytesDone <= 0) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return (bytesDone * 1000) / elapsedMs;
}

export function etaSeconds(bytesDone: number, bytesTotal: number, speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return UNKNOWN_ETA;
  const remaining = Math.max(0, bytesTotal - bytesDone);
  if (remaining === 0) return 0;
  return Math.min(UNKNOWN_ETA, Math.round(remaining / speed));
}

export function fraction(bytesDone: number, bytesTotal: number, percentFallback: number): number {
  if (bytesTotal > 0) return Math.min(1, Math.max(0, bytesDone / bytesTotal));
  if (!Number.isFinite(percentFallback)) return 0;
  return Math.min(1, Math.max(0, percentFallback / 100));
}
