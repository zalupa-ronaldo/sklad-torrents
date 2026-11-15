import { describe, expect, it } from "vitest";

import { planAutoRecompress } from "@/lib/transcode/auto-recompress";

describe("automatic recompress", () => {
  it("writes beside the source and leaves the original unless the panel flag is on", () => {
    const planned = planAutoRecompress([
      "D:\\Films\\Movie.mkv",
      "/Volumes/vault/Cinema/Dune.mp4",
      "Z:\\Films\\secret.mkv",
      "D:\\Films\\notes.txt",
    ]);
    expect(planned.jobs).toEqual([
      { source: "D:\\Films\\Movie.mkv", destination: "D:\\Films\\Movie.sklad-av1.mkv", replaceOriginal: false },
      { source: "/Volumes/vault/Cinema/Dune.mp4", destination: "/Volumes/vault/Cinema/Dune.sklad-av1.mkv", replaceOriginal: false },
    ]);
    expect(planned.jobs.every((job) => job.source !== job.destination && job.replaceOriginal === false)).toBe(true);
    expect(planned.skipped.map((item) => item.path)).toEqual(["Z:\\Films\\secret.mkv", "D:\\Films\\notes.txt"]);
    expect(planned.skipped[0]?.reason).toMatch(/E и Z/);

    const allowed = planAutoRecompress(["D:\\Films\\Movie.mkv"], true);
    expect(allowed.jobs[0]?.replaceOriginal).toBe(true);
    expect(allowed.jobs[0]?.destination).not.toBe(allowed.jobs[0]?.source);
  });
});
