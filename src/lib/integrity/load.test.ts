import { describe, expect, it } from "vitest";

import { createSha256, restoreSha256 } from "@/lib/integrity/sha256-state";
import { defaultCopyLoadPolicy, effectiveCopyLoad } from "@/lib/integrity/load";
import { sha256Hex } from "@/lib/integrity/hash";

describe("copy load", () => {
  it("keeps the panel process at normal priority and slows down when asked not to interfere", () => {
    const noon = new Date(2026, 0, 1, 12, 0, 0);
    const normal = effectiveCopyLoad(defaultCopyLoadPolicy(), noon);
    expect(normal.reniceProcess).toBe(false);
    expect(normal.maxParallel).toBe(2);
    expect(normal.bytesPerSecond).toBe(0);
    const quiet = effectiveCopyLoad({ ...defaultCopyLoadPolicy(), quiet: true }, noon);
    expect(quiet.maxParallel).toBe(1);
    expect(quiet.priority).toBe("background");
    expect(quiet.bytesPerSecond).toBe(4 * 1024 * 1024);
    expect(quiet.reason).toMatch(/не мешать/);
    const scheduled = effectiveCopyLoad(
      { ...defaultCopyLoadPolicy(), schedule: { enabled: true, start: "09:00", end: "18:00" } },
      noon,
    );
    expect(scheduled.quiet).toBe(true);
    const overnight = effectiveCopyLoad(
      { ...defaultCopyLoadPolicy(), schedule: { enabled: true, start: "18:00", end: "09:00" } },
      noon,
    );
    expect(overnight.quiet).toBe(false);
    const paused = effectiveCopyLoad({ ...defaultCopyLoadPolicy(), queuePaused: true }, noon);
    expect(paused.queuePaused).toBe(true);
    expect(paused.maxParallel).toBe(0);
  });
});

describe("resumable SHA-256", () => {
  it("matches a digest split across a checkpoint", () => {
    const whole = createSha256();
    whole.update(new TextEncoder().encode("abcdef"));
    const part = createSha256();
    part.update(new TextEncoder().encode("abc"));
    const continued = createSha256();
    continued.update(new TextEncoder().encode("abc"));
    const next = restoreSha256(continued.exportState());
    next.update(new TextEncoder().encode("def"));
    expect(next.digestHex()).toBe(whole.digestHex());
    expect(next.digestHex()).toBe(sha256Hex("abcdef"));
    expect(part.digestHex()).toBe(sha256Hex("abc"));
  });
});
