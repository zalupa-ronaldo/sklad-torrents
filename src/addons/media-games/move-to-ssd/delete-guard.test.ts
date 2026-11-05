import { describe, expect, it } from "vitest";

import { canDeleteSource } from "@/addons/media-games/move-to-ssd/delete-guard";
import { gameFolderFromHit, suggestSsdDestination } from "@/addons/media-games/move-to-ssd/game-folder";

describe("move-to-SSD source folder", () => {
  it("fills the source from a file hit's parent directory", () => {
    expect(gameFolderFromHit({ path: "D:\\Games\\Hades\\Hades.exe", isDirectory: false })).toBe("D:\\Games\\Hades");
    expect(gameFolderFromHit({ path: "/Volumes/vault/Games/Hades", isDirectory: true })).toBe(
      "/Volumes/vault/Games/Hades",
    );
    expect(suggestSsdDestination("D:\\Games\\Hades")).toBe("C:\\Games\\Hades");
    expect(suggestSsdDestination("/Volumes/vault/Games/Hades")).toBe("/Volumes/SSD/Games/Hades");
  });

  it("does not allow deleting the source until the copy is verified and the user confirms", () => {
    expect(canDeleteSource({ copyVerified: false, userConfirmed: false })).toBe(false);
    expect(canDeleteSource({ copyVerified: true, userConfirmed: false })).toBe(false);
    expect(canDeleteSource({ copyVerified: false, userConfirmed: true })).toBe(false);
    expect(canDeleteSource({ copyVerified: true, userConfirmed: true })).toBe(true);
  });
});
