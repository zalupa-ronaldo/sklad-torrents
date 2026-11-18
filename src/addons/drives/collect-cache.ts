export const DISKUTIL_CACHE_MS = 45_000;

export function createDiskutilCache(ttlMs = DISKUTIL_CACHE_MS, now = () => Date.now()) {
  let cached: { at: number; value: unknown } | null = null;
  let flight: Promise<unknown> | null = null;
  return function load<T>(run: () => Promise<T>): Promise<T> {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value as T);
    if (flight) return flight as Promise<T>;
    const pending = run().then(
      (value) => {
        cached = { at: now(), value };
        if (flight === pending) flight = null;
        return value;
      },
      (error) => {
        if (flight === pending) flight = null;
        throw error;
      },
    );
    flight = pending;
    return pending;
  };
}
