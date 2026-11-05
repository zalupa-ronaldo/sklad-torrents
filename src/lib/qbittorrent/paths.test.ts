import { describe, expect, it } from "vitest";

import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { assertPathForOs, joinRemotePath, normalizeRemotePath } from "@/lib/qbittorrent/paths";
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
