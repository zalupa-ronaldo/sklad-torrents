import { describe, expect, it } from "vitest";

import { resolveFilesystem } from "@/lib/drive/filesystem";

describe("filesystem", () => {
  it("does not treat a Mac APFS path as NTFS", () => {
    const macPath = "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv";
    expect(resolveFilesystem({ os: "darwin", filesystem: "apfs", path: macPath })).toBe("apfs");
    expect(resolveFilesystem({ os: "darwin", filesystem: "apfs", path: macPath })).not.toBe("ntfs");
    expect(resolveFilesystem({ os: "darwin", filesystem: "ntfs", path: macPath })).toBe("apfs");
    expect(resolveFilesystem({ os: "darwin", filesystem: "ntfs", path: macPath })).not.toBe("ntfs");
    expect(resolveFilesystem({ os: "win32", filesystem: "ntfs", path: "D:\\Games\\Control\\data.pack" })).toBe("ntfs");
  });
});
