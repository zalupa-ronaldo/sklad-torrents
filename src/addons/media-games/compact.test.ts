import { describe, expect, it } from "vitest";

import { buildCompactArgv, compressAvailability } from "@/addons/media-games/compact";
import { ToolsError } from "@/addons/media-games/errors";

const COMPACT = "C:\\Windows\\System32\\compact.exe";

describe("compact.exe arguments", () => {
  it("maps algorithms to compact /C /EXE and a folder", () => {
    expect(
      buildCompactArgv({
        os: "win32",
        binary: COMPACT,
        folder: "D:\\Games\\Control",
        algorithm: "LZX",
      }),
    ).toEqual([COMPACT, "/C", "/EXE:LZX", "/S:D:\\Games\\Control"]);
    expect(
      buildCompactArgv({
        os: "win32",
        binary: COMPACT,
        folder: "D:/Games/Control",
        algorithm: "XPRESS8K",
      })[2],
    ).toBe("/EXE:XPRESS8K");
    expect(
      buildCompactArgv({
        os: "win32",
        binary: COMPACT,
        folder: "\\\\nas\\games\\Control",
        algorithm: "XPRESS16K",
      })[3],
    ).toBe("/S:\\\\nas\\games\\Control");
    expect(buildCompactArgv({ os: "win32", binary: COMPACT, folder: "E:\\Archive", algorithm: "XPRESS4K" })[2]).toBe(
      "/EXE:XPRESS4K",
    );
  });

  it("rejects macOS hosts and APFS paths such as /Volumes/vault", () => {
    expect(() =>
      buildCompactArgv({
        os: "darwin",
        binary: "compact",
        folder: "/Volumes/vault/Games/Title",
        algorithm: "LZX",
      }),
    ).toThrow(ToolsError);
    expect(() =>
      buildCompactArgv({
        os: "darwin",
        binary: COMPACT,
        folder: "D:\\Games\\Control",
        algorithm: "XPRESS8K",
      }),
    ).toThrow(/Только Windows, NTFS/);
    expect(() =>
      buildCompactArgv({
        os: "win32",
        binary: COMPACT,
        folder: "/Volumes/vault",
        algorithm: "LZX",
      }),
    ).toThrow(/APFS|NTFS/);
    expect(compressAvailability("darwin", "/Volumes/vault/Games/Title")).toEqual({
      ok: false,
      reason: "Только Windows, NTFS.",
    });
    expect(compressAvailability("win32", "C:\\Games\\Control").ok).toBe(true);
  });
});
