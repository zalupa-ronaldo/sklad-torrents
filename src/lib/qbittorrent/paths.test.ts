import { describe, expect, it } from "vitest";

import { QbittorrentError } from "@/lib/qbittorrent/errors";
import {
  assertAllowedTorrentPath,
  assertPathForOs,
  assertSavePath,
  describeTorrentLocation,
  isForbiddenTorrentVolume,
  joinRemotePath,
  normalizeRemotePath,
  pathForWindowsPanel,
  windowsPathToWsl,
  wslPathToWindows,
} from "@/lib/qbittorrent/paths";
import { normalizeBaseUrl } from "@/lib/qbittorrent/urls";

describe("remote paths", () => {
  it("joins macOS paths without duplicating slashes", () => {
    expect(joinRemotePath("darwin", "/Volumes/vault/Cinema/", "Interstellar.2014.2160p.mkv")).toBe(
      "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
    );
    expect(
      joinRemotePath("darwin", "/Volumes/vault/PSP/Games/Downloads", "God of War (PSP)/ISO/ULUS10479.iso"),
    ).toBe("/Volumes/vault/PSP/Games/Downloads/God of War (PSP)/ISO/ULUS10479.iso");
  });

  it("joins Windows paths with backslashes", () => {
    expect(joinRemotePath("win32", "D:/Games", "Control Ultimate Edition/data/pack0.pack")).toBe(
      "D:\\Games\\Control Ultimate Edition\\data\\pack0.pack",
    );
    expect(normalizeRemotePath("win32", "D:\\Downloads\\")).toBe("D:\\Downloads");
  });

  it("rejects a Windows path on a Mac host", () => {
    expect(() => assertPathForOs("darwin", "D:\\Downloads")).toThrow(QbittorrentError);
  });

  it("accepts a WSL mount and shows it as a Windows path", () => {
    expect(assertPathForOs("win32", "/mnt/d/Downloads")).toBe("D:\\Downloads");
    expect(pathForWindowsPanel("/mnt/d/Downloads/")).toBe("D:\\Downloads");
    expect(assertPathForOs("win32", "/mnt/s/Software")).toBe("S:\\Software");
  });

  it("rejects drive Z and its WSL mount", () => {
    expect(() => assertPathForOs("win32", "Z:\\Archive")).toThrow(/Диск Z:/);
    expect(() => assertPathForOs("win32", "/mnt/z/Archive")).toThrow(/Диск Z:/);
    expect(() => assertPathForOs("win32", "\\\\?\\Z:\\")).toThrow(/Диск Z:/);
    expect(() => pathForWindowsPanel("/mnt/z/secret.bin")).toThrow(/Диск Z:/);
  });

  it("normalizes the Web UI root and strips an accidental /api/v2 suffix", () => {
    expect(normalizeBaseUrl("http://192.168.1.20:8080/")).toBe("http://192.168.1.20:8080");
    expect(normalizeBaseUrl("http://127.0.0.1:8080/api/v2")).toBe("http://127.0.0.1:8080");
    expect(normalizeBaseUrl("https://mini.local:8443/qb/api/v2/")).toBe("https://mini.local:8443/qb");
  });

  it("rejects non-http addresses", () => {
    expect(() => normalizeBaseUrl("ftp://192.168.1.20")).toThrow(QbittorrentError);
    expect(() => normalizeBaseUrl("http://user:pass@192.168.1.20:8080")).toThrow(/отдельных полях/);
  });
});

describe("WSL and Windows path families", () => {
  it("maps a drive letter both ways and keeps a folder that only contains z", () => {
    expect(windowsPathToWsl("D:\\Games\\Pack")).toBe("/mnt/d/Games/Pack");
    expect(wslPathToWindows("/mnt/d/Games/Pack")).toBe("D:\\Games\\Pack");
    expect(windowsPathToWsl("D:\\Foo\\\\Bar")).toBe("/mnt/d/Foo/Bar");
    expect(windowsPathToWsl("D:\\")).toBe("/mnt/d");
    expect(wslPathToWindows("/mnt/e")).toBe("E:\\");
    expect(isForbiddenTorrentVolume("D:\\")).toBe(false);
    expect(isForbiddenTorrentVolume("/mnt/d")).toBe(false);
    expect(isForbiddenTorrentVolume("D:\\Games\\puzzle")).toBe(false);
    expect(isForbiddenTorrentVolume("/tmp/zoom")).toBe(false);
  });

  it("rejects drive Z and does not invent a Windows path for a Mac volume", () => {
    for (const input of ["Z:\\", "z:/", "\\\\?\\Z:\\", "/mnt/z", "/mnt/Z", "/mnt/z/secret.bin"]) {
      expect(isForbiddenTorrentVolume(input)).toBe(true);
      expect(windowsPathToWsl(input)).toBeNull();
      expect(wslPathToWindows(input)).toBeNull();
      try {
        assertAllowedTorrentPath(input);
        expect.fail(input);
      } catch (error) {
        expect(error).toBeInstanceOf(QbittorrentError);
        expect((error as QbittorrentError).code).toBe("validation");
        expect((error as QbittorrentError).message).toBe("Диск Z: не используется. Выберите другой каталог.");
      }
    }
    expect(wslPathToWindows("/Volumes/vault")).toBeNull();
    expect(windowsPathToWsl("/Volumes/vault")).toBeNull();
    expect(describeTorrentLocation("/Volumes/vault", "/Volumes/vault/Cinema")).toEqual({
      seedingFrom: "/Volumes/vault",
      contentPath: "/Volumes/vault/Cinema",
      windowsPath: null,
      wslPath: null,
    });
    expect(describeTorrentLocation("D:\\Games", "D:\\Games\\Pack")).toEqual({
      seedingFrom: "D:\\Games",
      contentPath: "D:\\Games\\Pack",
      windowsPath: "D:\\Games",
      wslPath: "/mnt/d/Games",
    });
  });

  it("accepts a WSL mount or a Windows drive when the host style is wsl", () => {
    expect(assertSavePath("win32", "wsl", "D:\\Downloads")).toBe("/mnt/d/Downloads");
    expect(assertSavePath("win32", "wsl", "/mnt/d/Downloads/")).toBe("/mnt/d/Downloads");
    expect(assertSavePath("darwin", undefined, "/Volumes/vault/Downloads")).toBe("/Volumes/vault/Downloads");
    expect(() => assertSavePath("win32", "wsl", "Z:\\Games")).toThrow(/Диск Z:/);
    expect(() => assertSavePath("win32", "windows", "Z:\\Games")).toThrow(/Диск Z:/);
  });
});
