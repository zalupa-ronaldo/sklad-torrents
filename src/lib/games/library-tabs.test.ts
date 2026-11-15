import { describe, expect, it } from "vitest";

import { emptyLaunchTools } from "@/lib/games/launch";
import { libraryTabs, type GameRecord } from "@/lib/games/library";

function record(patch: Partial<GameRecord> & Pick<GameRecord, "name" | "root">): GameRecord {
  return {
    id: patch.name,
    steamAppId: null,
    pool: "",
    destination: "",
    exe: "",
    args: [],
    saves: [],
    provenance: "explicit",
    confidence: "low",
    needsReview: false,
    unmanaged: false,
    online: true,
    lastSeenAt: null,
    location: patch.root,
    state: "registered",
    copyVerified: false,
    ready: false,
    compact: "not-run",
    compactReason: "",
    compressed: false,
    ntfsSmoke: false,
    pcIntegration: "not-verified",
    compactDbPath: null,
    jobId: null,
    managed: true,
    pinned: "until-explicit-remove",
    manifest: [],
    saveFingerprints: [],
    reason: "",
    ...patch,
  };
}

describe("library platform tabs", () => {
  const games = [
    record({
      name: "Hades",
      root: "D:\\Steam\\steamapps\\common\\Hades",
      exe: "Hades.exe",
      steamAppId: 1145360,
      developer: "Supergiant Games",
      year: 2020,
      summary: "Рогалик",
    }),
    record({ name: "God of War", root: "D:\\PSP\\ULUS10479.iso" }),
    record({ name: "Shadow of the Colossus", root: "D:\\PS2\\SLUS21242.iso" }),
    record({ name: "Bloodborne", root: "D:\\PS4\\CUSA00900" }),
    record({ name: "Zelda", root: "D:\\Switch\\01007EF00011E000.nsp" }),
    record({ name: "Hollow Knight", root: "/Applications/Hollow Knight.app" }),
    record({ name: "Gothic II", root: "D:\\Games\\Gothic II", exe: "Gothic2.exe", steamAppId: 39510 }),
  ];

  it("keeps each system on its own tab and shows one launcher, a cover and metadata", () => {
    const tabs = libraryTabs(games, { ...emptyLaunchTools(), openGothic: "C:\\Ports\\OpenGothic.exe" });
    expect(tabs.map((tab) => tab.id)).toEqual(["windows", "macos", "switch", "psp", "ps2", "ps4"]);

    const windows = tabs.find((tab) => tab.id === "windows")!;
    expect(windows.games.map((game) => game.name).sort()).toEqual(["Gothic II", "Hades"]);
    expect(windows.games.every((game) => game.platform === "windows")).toBe(true);

    const hades = windows.games.find((game) => game.name === "Hades")!;
    expect(hades.developer).toBe("Supergiant Games");
    expect(hades.year).toBe(2020);
    expect(hades.summary).toBe("Рогалик");
    expect(hades.coverDataUrl).toMatch(/^data:image\/svg\+xml/);
    expect(hades.launch).toMatchObject({ program: "Hades.exe", kind: "native", machineLabel: "Windows PC" });

    const gothic = windows.games.find((game) => game.name === "Gothic II")!;
    expect(gothic.launch?.kind).toBe("port");
    expect(gothic.launch?.program).toBe("OpenGothic");

    expect(tabs.find((tab) => tab.id === "psp")?.games[0]?.launch).toMatchObject({ program: "PPSSPP", kind: "emulator", machineLabel: "Windows PC" });
    expect(tabs.find((tab) => tab.id === "ps2")?.games[0]?.launch?.program).toBe("PCSX2");
    expect(tabs.find((tab) => tab.id === "ps4")?.games[0]?.launch?.program).toBe("shadPS4");
    expect(tabs.find((tab) => tab.id === "switch")?.games[0]?.launch?.program).toBe("Ryujinx");
    expect(tabs.find((tab) => tab.id === "macos")?.games[0]?.launch).toMatchObject({ kind: "native", machineLabel: "Mac" });

    const dumped = JSON.stringify(tabs);
    expect(dumped).not.toMatch(/https?:\/\//);
    expect(dumped).toMatch(/не скачиваются/);
  });
});
