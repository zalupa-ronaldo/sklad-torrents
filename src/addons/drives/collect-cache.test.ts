import { describe, expect, it } from "vitest";

import { createDiskutilCache, DISKUTIL_CACHE_MS } from "@/addons/drives/collect-cache";

describe("diskutil cache", () => {
  it("stays inside 30–60 seconds and never runs two collects at once", async () => {
    expect(DISKUTIL_CACHE_MS).toBeGreaterThanOrEqual(30_000);
    expect(DISKUTIL_CACHE_MS).toBeLessThanOrEqual(60_000);
    let now = 1_000;
    let calls = 0;
    let release: (value: string) => void = () => undefined;
    const cache = createDiskutilCache(45_000, () => now);
    const first = cache(
      () =>
        new Promise((resolve) => {
          calls += 1;
          release = resolve;
        }),
    );
    const second = cache(() => {
      calls += 1;
      return Promise.resolve("other");
    });
    expect(calls).toBe(1);
    release("diskutil");
    await expect(first).resolves.toBe("diskutil");
    await expect(second).resolves.toBe("diskutil");
    now += 10_000;
    await expect(cache(async () => {
      calls += 1;
      return "fresh";
    })).resolves.toBe("diskutil");
    expect(calls).toBe(1);
    now += 45_000;
    await expect(cache(async () => {
      calls += 1;
      return "again";
    })).resolves.toBe("again");
    expect(calls).toBe(2);
  });
});
