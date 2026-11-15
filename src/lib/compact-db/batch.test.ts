import { describe, expect, it } from "vitest";

import { compactKeptBytes, nextCompactFile } from "@/lib/compact-db/batch";
import { DEFAULT_MACHINE_LIMIT } from "@/lib/transcode/workload";

describe("CompactGUI file batch", () => {
  it("pauses before the next file and does not accept a changed hash", () => {
    const files = ["a.bin", "b.bin"];
    expect(nextCompactFile({ files, done: [], paused: false, limit: DEFAULT_MACHINE_LIMIT, running: 0 }).file).toBe("a.bin");
    expect(nextCompactFile({ files, done: ["a.bin"], paused: true, limit: DEFAULT_MACHINE_LIMIT, running: 0 }).file).toBeNull();
    expect(nextCompactFile({ files, done: ["a.bin"], paused: false, limit: { ...DEFAULT_MACHINE_LIMIT, userBusy: true }, running: 0 }).file).toBeNull();
    expect(nextCompactFile({ files, done: ["a.bin"], paused: false, limit: DEFAULT_MACHINE_LIMIT, running: 0 }).file).toBe("b.bin");
    expect(compactKeptBytes("ab".repeat(32), "ab".repeat(32)).ok).toBe(true);
    expect(compactKeptBytes("ab".repeat(32), "cd".repeat(32)).ok).toBe(false);
  });
});
