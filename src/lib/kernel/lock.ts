const tails = new Map<string, Promise<void>>();

/** Serializes async access in this process. Agents talk to the server over HTTP, so they share this lock. */
export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    name,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
