import { describe, expect, it } from "vitest";

import { planAutoCompact, runAutoCompact } from "@/lib/compact-db/auto";
import type { CompactLookup } from "@/lib/compact-db/database";

const hit: CompactLookup = {
  status: "hit",
  steamAppId: 1,
  algorithm: "XPRESS8K",
  beforeBytes: 1000,
  afterBytes: 400,
  sampleCount: 3,
  savings: 0.6,
  confidence: 1,
  source: "test",
  updatedAt: "2026-11-15T00:00:00Z",
};

const files = [
  { path: "D:\\Games\\A\\a.bin", sha256: "ab".repeat(32) },
  { path: "D:\\Games\\A\\b.bin", sha256: "cd".repeat(32) },
];

describe("automatic CompactGUI", () => {
  it("does not start on Z: or when the database has no saving", () => {
    expect(planAutoCompact({
      os: "win32",
      filesystem: "NTFS",
      root: "Z:\\Games\\A",
      files,
      lookup: hit,
      algorithm: "XPRESS8K",
      alreadyAlgorithm: null,
      minSavings: null,
    }).run).toBe(false);
    const unknown: CompactLookup = { status: "unknown", steamAppId: 1, algorithm: "XPRESS8K", source: "test" };
    expect(planAutoCompact({
      os: "win32",
      filesystem: "NTFS",
      root: "D:\\Games\\A",
      files,
      lookup: unknown,
      algorithm: "XPRESS8K",
      alreadyAlgorithm: null,
      minSavings: null,
    }).run).toBe(false);
  });

  it("pauses before the next file and stops when the bytes change, without deleting", async () => {
    const seen: string[] = [];
    const paused = await runAutoCompact({
      root: "D:\\Games\\A",
      files,
      paused: true,
      compress: async (file) => {
        seen.push(file);
        return { code: 0 };
      },
      hash: async () => "ab".repeat(32),
    });
    expect(seen).toEqual([]);
    expect(paused).toMatchObject({ compressed: false, deleted: false, done: [] });

    const changed = await runAutoCompact({
      root: "D:\\Games\\A",
      files: [files[0]!],
      compress: async () => ({ code: 0 }),
      hash: async () => "ff".repeat(32),
    });
    expect(changed).toMatchObject({ compressed: false, deleted: false, done: [] });
    expect(changed.reason).toMatch(/SHA-256/);
  });

  it("keeps going only while each file still hashes to the same bytes", async () => {
    const done = await runAutoCompact({
      root: "D:\\Games\\A",
      files,
      compress: async () => ({ code: 0 }),
      hash: async (file) => files.find((item) => item.path === file)!.sha256,
    });
    expect(done).toMatchObject({ compressed: true, deleted: false, done: [files[0]!.path, files[1]!.path] });
  });
});
