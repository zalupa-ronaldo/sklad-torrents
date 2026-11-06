import { describe, expect, it } from "vitest";
import { isZMount, safeRelativePath, uniqueFileName } from "@/addons/drives/transfer/paths";
import { displayDiskPickerLabel, displayDiskTitle, isRemovableDisk } from "@/addons/drives/inventory";

describe("transfer paths", () => {
  it("accepts relative paths only", () => {
    expect(safeRelativePath("games/mac/a.dmg")).toBe("games/mac/a.dmg");
    expect(safeRelativePath("..\\Windows\\System32")).toBeNull();
    expect(safeRelativePath("S:\\games\\a.dmg")).toBeNull();
    expect(safeRelativePath("/etc/passwd")).toBeNull();
  });
  it("detects Z", () => {
    expect(isZMount("Z:\\")).toBe(true);
    expect(isZMount("S:\\")).toBe(false);
  });
  it("avoids clobber names", () => {
    const name = uniqueFileName("/tmp", "a.dmg", (full) => full.endsWith("/a.dmg"));
    expect(name).not.toBe("a.dmg");
    expect(name.endsWith(".dmg")).toBe(true);
  });
});

describe("disk titles", () => {
  it("puts capacity before the name", () => {
    expect(
      displayDiskTitle({
        label: "Games",
        volumeName: "Games",
        lastMountPath: "S:\\",
        mountPaths: ["S:\\"],
        totalBytes: 12_000_000_000_000,
        filesystem: "NTFS",
      }),
    ).toMatch(/ТБ · S:/);
  });
  it("marks flash drives", () => {
    const disk = {
      label: "NO NAME 1",
      volumeName: "NO NAME 1",
      lastMountPath: "/Volumes/NO NAME 1",
      mountPaths: ["/Volumes/NO NAME 1"],
      totalBytes: 16_000_000_000,
      freeBytes: 14_200_000_000,
      filesystem: "MS-DOS FAT32",
    };
    expect(isRemovableDisk(disk)).toBe(true);
    expect(displayDiskPickerLabel(disk)).toMatch(/Флешка/);
    expect(displayDiskPickerLabel(disk)).toMatch(/свободно/);
  });
});
