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

/** One diskutil info per mount, never two at once. Forgotten when the volume detaches. */
export function createVolumeInfoCache() {
  const values = new Map<string, unknown>();
  let tail: Promise<void> = Promise.resolve();
  return {
    async once<T>(key: string, run: () => Promise<T>): Promise<T> {
      const pending = tail.then(async () => {
        if (values.has(key)) return values.get(key) as T;
        const value = await run();
        values.set(key, value);
        return value;
      });
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    forget(key: string) {
      values.delete(key);
    },
  };
}
