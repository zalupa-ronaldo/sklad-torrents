import { describe, expect, it } from "vitest";

import { emptyLaunchTools, planLaunch, type LaunchTools } from "@/lib/games/launch";
import { classifyShelfPlatform } from "@/lib/games/platforms";

const tools = (patch: Partial<LaunchTools> = {}): LaunchTools => ({ ...emptyLaunchTools(), ...patch });

describe("platform tabs", () => {
  it("keeps consoles and macOS off the Windows tab", () => {
    expect(classifyShelfPlatform({ name: "Hades", path: "D:\\Games\\Hades\\Hades.exe" })).toBe("windows");
    expect(classifyShelfPlatform({ name: "Hollow Knight", path: "/Applications/Hollow Knight.app" })).toBe("macos");
    expect(classifyShelfPlatform({ name: "Zelda", path: "D:\\Switch\\01007EF00011E000.nsp" })).toBe("switch");
    expect(classifyShelfPlatform({ name: "God of War", path: "D:\\PSP\\Games\\foo.exe" })).toBe("psp");
    expect(classifyShelfPlatform({ name: "Colossus", path: "D:\\PS2\\SLUS21242.iso" })).toBe("ps2");
    expect(classifyShelfPlatform({ name: "Bloodborne", path: "D:\\PS4\\CUSA00900\\game.iso" })).toBe("ps4");
    expect(classifyShelfPlatform({ name: "a movie", path: "D:\\Cinema\\movie.iso" })).toBeNull();
    expect(classifyShelfPlatform({ name: "setup", path: "D:\\Downloads\\setup.pkg" })).toBeNull();
  });
});

describe("one launch button", () => {
  it("picks PPSSPP, PCSX2, shadPS4 and Ryujinx", () => {
    const psp = planLaunch({
      name: "Chains of Olympus",
      platform: "psp",
      contentPath: "D:\\PSP\\ULUS10353.iso",
      tools: tools({ ppsspp: "C:\\Emu\\PPSSPP.exe" }),
    });
    expect(psp).toMatchObject({ program: "PPSSPP", kind: "emulator", machine: "pc-agent", machineLabel: "Windows PC", ready: true });
    expect(psp.argv).toEqual(["C:\\Emu\\PPSSPP.exe", "D:\\PSP\\ULUS10353.iso"]);

    const ps2 = planLaunch({
      name: "Colossus",
      platform: "ps2",
      contentPath: "/Volumes/vault/PS2/SLUS21242.iso",
      tools: tools({ pcsx2: "/Applications/PCSX2.app/Contents/MacOS/pcsx2" }),
    });
    expect(ps2.machineLabel).toBe("Mac");
    expect(ps2.program).toBe("PCSX2");
    expect(ps2.kind).toBe("emulator");

    const ps4 = planLaunch({
      name: "Bloodborne",
      platform: "ps4",
      contentPath: "D:\\PS4\\CUSA00900.iso",
      tools: tools({ shadps4: "C:\\Emu\\shadPS4.exe" }),
    });
    expect(ps4.program).toBe("shadPS4");

    const analog = planLaunch({
      name: "Zelda",
      platform: "switch",
      contentPath: "D:\\Switch\\game.nsp",
      tools: tools({ ryujinx: "C:\\Emu\\suyu.exe" }),
    });
    expect(analog.program).toBe("suyu");
    expect(analog.kind).toBe("emulator");
    expect(analog.argv).toHaveLength(2);
  });

  it("uses OpenGothic when the port is on disk and the native exe otherwise", () => {
    const port = planLaunch({
      name: "Gothic II",
      platform: "windows",
      contentPath: "D:\\Games\\Gothic II",
      tools: tools({ openGothic: "C:\\Ports\\OpenGothic.exe" }),
    });
    expect(port.kind).toBe("port");
    expect(port.program).toBe("OpenGothic");
    expect(port.argv).toEqual(["C:\\Ports\\OpenGothic.exe", "--gamedir", "D:\\Games\\Gothic II"]);

    const native = planLaunch({
      name: "Gothic II",
      platform: "windows",
      contentPath: "D:\\Games\\Gothic II\\Gothic2.exe",
      tools: tools(),
    });
    expect(native.kind).toBe("native");
    expect(native.program).toBe("Gothic2.exe");
    expect(native.argv).toEqual(["D:\\Games\\Gothic II\\Gothic2.exe"]);
  });

  it("does not fetch firmware or keys", () => {
    const blocked = planLaunch({
      name: "Colossus",
      platform: "ps2",
      contentPath: "D:\\PS2\\SLUS21242.iso",
      tools: tools({ pcsx2: "C:\\Emu\\pcsx2.exe" }),
      firmwarePath: "https://example.com/scph10000.bin",
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.argv).toEqual([]);
    expect(blocked.reason).toMatch(/скачивание/i);
    expect(blocked.firmwareNote).toMatch(/не скачиваются/);
  });
});
