import { describe, expect, it } from "vitest";

import { buildHandBrakeArgv, resolveHandBrakeBinary, suggestTranscodeOutput } from "@/addons/media-games/handbrake";
import { formatArgv } from "@/addons/media-games/paths";

describe("HandBrake command builder", () => {
  it("builds a macOS argv with preset, input, and output", () => {
    const argv = buildHandBrakeArgv({
      binary: "/usr/local/bin/HandBrakeCLI",
      inputPath: "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
      outputPath: "/Volumes/vault/Cinema/Interstellar.2014.1080p.mp4",
      preset: "Fast 1080p30",
    });
    expect(argv).toEqual([
      "/usr/local/bin/HandBrakeCLI",
      "--preset",
      "Fast 1080p30",
      "-i",
      "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
      "-o",
      "/Volumes/vault/Cinema/Interstellar.2014.1080p.mp4",
    ]);
    expect(formatArgv(argv)).toContain('"Fast 1080p30"');
  });

  it("builds a Windows argv and keeps backslashes in one argument each", () => {
    const argv = buildHandBrakeArgv({
      binary: "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe",
      inputPath: "D:\\Downloads\\Movie.mkv",
      outputPath: "C:\\Videos\\Movie.1080p.mp4",
      preset: "Very Fast 1080p30",
    });
    expect(argv).toEqual([
      "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe",
      "--preset",
      "Very Fast 1080p30",
      "-i",
      "D:\\Downloads\\Movie.mkv",
      "-o",
      "C:\\Videos\\Movie.1080p.mp4",
    ]);
  });

  it("suggests an mp4 next to a video and prefers a binary that exists", () => {
    expect(suggestTranscodeOutput("darwin", "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv")).toBe(
      "/Volumes/vault/Cinema/Interstellar.2014.2160p.1080p.mp4",
    );
    expect(suggestTranscodeOutput("win32", "D:\\Downloads\\Movie.mkv")).toBe("D:\\Downloads\\Movie.1080p.mp4");
    expect(suggestTranscodeOutput("darwin", "/Volumes/vault/Games/Control")).toBe("");
    const resolved = resolveHandBrakeBinary(
      {
        os: "win32",
        handbrakePath: "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe",
        handbrakeExtra: "D:\\Tools\\HandBrakeCLI.exe",
      },
      (filePath) => filePath === "D:\\Tools\\HandBrakeCLI.exe",
    );
    expect(resolved).toEqual({ binary: "D:\\Tools\\HandBrakeCLI.exe", found: true });
  });
});
