import { describe, expect, it } from "vitest";

import { CD_BYTES, DVD_DL_BYTES, DVD_SL_BYTES, checkCapacity, treeBytes } from "@/lib/optical/capacity";

describe("optical capacity", () => {
  const profiles = [
    ["cd", CD_BYTES],
    ["dvd-sl", DVD_SL_BYTES],
    ["dvd-dl", DVD_DL_BYTES],
  ] as const;

  it.each(profiles)("accepts just under and the exact %s limit, rejects just over", (profile, limit) => {
    expect(checkCapacity(limit - 1, profile).ok).toBe(true);
    expect(checkCapacity(limit, profile).ok).toBe(true);
    const over = checkCapacity(limit + 1, profile);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toMatch(/Не влезает/);
  });

  it("sums a tree before the profile check", () => {
    const files = [{ size: CD_BYTES - 10 }, { size: 11 }];
    const over = checkCapacity(treeBytes(files), "cd");
    expect(over.ok).toBe(false);
  });
});
