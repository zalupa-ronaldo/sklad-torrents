import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addShelfGame, launchShelfGame, readShelf, returnToHdd, saveGameFirmware, saveShelfTools, shelfCompactPlan, wantToPlay } from "@/lib/games/shelf";

const dirs: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<{ data: string; pool: string; hdd: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "sklad-shelf-"));
  dirs.push(root);
  const data = path.join(root, "data");
  const pool = path.join(root, "ssd");
  const hdd = path.join(root, "hdd");
  await mkdir(data);
  await mkdir(pool);
  await mkdir(hdd);
  return { data, pool, hdd };
}

describe("game shelf", () => {
  it("shows six platform tabs and one launcher on each card", async () => {
    const { data } = await workspace();
    const shelf = await readShelf(data);
    expect(shelf.showingSamples).toBe(true);
    expect(shelf.platforms.map((item) => item.id)).toEqual(["windows", "macos", "switch", "psp", "ps2", "ps4"]);
    const windows = shelf.platforms.find((item) => item.id === "windows");
    expect(windows?.games.every((game) => game.platform === "windows")).toBe(true);
    expect(windows?.games[0]?.coverDataUrl).toMatch(/^data:image\/svg\+xml/);
    expect(windows?.games[0]?.developer).toBe("Supergiant Games");
    expect(windows?.games[0]?.year).toBe(2020);
    expect(windows?.games[0]?.launch.machineLabel).toBe("Windows PC");
    expect(windows?.games.some((game) => game.platform !== "windows")).toBe(false);
    expect(shelf.platforms.find((item) => item.id === "psp")?.games[0]?.launch.program).toBe("PPSSPP");
    expect(shelf.platforms.find((item) => item.id === "ps2")?.games[0]?.launch.program).toBe("PCSX2");
    expect(shelf.platforms.find((item) => item.id === "ps4")?.games[0]?.launch.program).toBe("shadPS4");
    expect(shelf.platforms.find((item) => item.id === "switch")?.games[0]?.launch.program).toBe("Ryujinx");
    for (const platform of shelf.platforms) {
      for (const game of platform.games) {
        expect(game.launch.kind === "native" || game.launch.kind === "emulator" || game.launch.kind === "port").toBe(true);
        expect(game.sourceKept).toBe(true);
      }
    }
  });

  it("plans CompactGUI for a Windows SSD copy and does not open the disk from here", async () => {
    const { data } = await workspace();
    const plan = shelfCompactPlan("C:\\Games\\Hades");
    expect(plan.state).toBe("planned");
    expect(plan.argv).toEqual(["C:\\Windows\\System32\\compact.exe", "/C", "/EXE:XPRESS8K", "/S:C:\\Games\\Hades"]);
    expect(() => shelfCompactPlan("Z:\\Games\\Hades")).toThrow(/Z/);

    const moved = await wantToPlay("sample-hades", data);
    expect(moved.copied).toBe(false);
    expect(moved.sourceKept).toBe(true);
    expect(moved.game.compactArgv).toEqual(plan.argv);
    expect(moved.game.hddPath.startsWith("D:\\")).toBe(true);
  });

  it("copies to the SSD pool, keeps the original, and removes only the pool copy on the way back", async () => {
    const { data, pool, hdd } = await workspace();
    const source = path.join(hdd, "Hades");
    await mkdir(path.join(source, "bin"), { recursive: true });
    await writeFile(path.join(source, "bin", "Hades.exe"), "hades-bytes");
    await writeFile(path.join(source, "cover.png"), png);
    await writeFile(
      path.join(source, "sklad.json"),
      JSON.stringify({ developer: "Supergiant Games", year: 2020, summary: "Рогалик", firmwareUrl: "https://evil.example/fw.bin" }),
    );
    const added = await addShelfGame({ path: source, pool, name: "Hades" }, data);
    expect(added.game.platform).toBe("windows");
    expect(added.game.developer).toBe("Supergiant Games");
    expect(added.game.year).toBe(2020);
    expect(added.game.coverDataUrl).toMatch(/^data:image\/png/);
    expect(added.game.firmwarePath).toBeNull();
    expect(await readFile(path.join(data, "game-shelf.json"), "utf8")).not.toContain("https://");

    const played = await wantToPlay(added.game.id, data);
    expect(played.copied).toBe(true);
    expect(played.sourceKept).toBe(true);
    expect(played.game.placement).toBe("В пуле на SSD");
    expect(await readFile(path.join(source, "bin", "Hades.exe"), "utf8")).toBe("hades-bytes");
    expect(await readFile(path.join(pool, "Hades", "bin", "Hades.exe"), "utf8")).toBe("hades-bytes");

    await writeFile(path.join(source, "bin", "Hades.exe"), "changed");
    await expect(returnToHdd(added.game.id, data)).rejects.toThrow(/SHA-256/);
    expect(await readFile(path.join(pool, "Hades", "bin", "Hades.exe"), "utf8")).toBe("hades-bytes");
    expect(await readFile(path.join(source, "bin", "Hades.exe"), "utf8")).toBe("changed");

    await writeFile(path.join(source, "bin", "Hades.exe"), "hades-bytes");
    const back = await returnToHdd(added.game.id, data);
    expect(back.removedSsd).toBe(true);
    expect(back.sourceKept).toBe(true);
    await expect(stat(path.join(pool, "Hades"))).rejects.toThrow();
    expect(await readFile(path.join(source, "bin", "Hades.exe"), "utf8")).toBe("hades-bytes");
  });

  it("restores a missing cold copy before dropping the SSD copy", async () => {
    const { data, pool, hdd } = await workspace();
    const source = path.join(hdd, "Celeste");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "Celeste.exe"), "celeste");
    const added = await addShelfGame({ path: source, pool, name: "Celeste" }, data);
    await wantToPlay(added.game.id, data);
    await rm(source, { recursive: true });
    const back = await returnToHdd(added.game.id, data);
    expect(back.sourceKept).toBe(true);
    expect(await readFile(path.join(source, "Celeste.exe"), "utf8")).toBe("celeste");
    await expect(stat(path.join(pool, "Celeste"))).rejects.toThrow();
  });

  it("refuses firmware URLs, Z:, symlinks and an oversized folder", async () => {
    const { data, pool, hdd } = await workspace();
    await expect(saveGameFirmware("sample-sotc", { firmwarePath: "https://example.com/scph10000.bin" }, data)).rejects.toThrow(/скачивание/);
    expect(await readFile(path.join(data, "game-shelf.json"), "utf8").catch(() => "")).not.toContain("https://");
    await saveGameFirmware("sample-sotc", { firmwarePath: "D:\\Bios\\scph10000.bin" }, data);
    expect(await readFile(path.join(data, "game-shelf.json"), "utf8")).toContain("D:\\\\Bios\\\\scph10000.bin");

    await expect(addShelfGame({ path: "Z:\\Games\\Secret", pool: "C:\\Games", name: "Secret" }, data)).rejects.toThrow(/Z/);
    await expect(addShelfGame({ path: "E:\\Games\\Secret", pool: "C:\\Games", name: "Secret" }, data)).rejects.toThrow(/E и Z/);

    const linked = path.join(hdd, "Linked");
    await mkdir(linked, { recursive: true });
    await writeFile(path.join(linked, "Game.exe"), "ok");
    await symlink(path.join(linked, "Game.exe"), path.join(linked, "alias.exe"));
    const added = await addShelfGame({ path: linked, pool, name: "Linked" }, data);
    await expect(wantToPlay(added.game.id, data)).rejects.toThrow(/Ссылки/);
    expect(await readFile(path.join(linked, "Game.exe"), "utf8")).toBe("ok");
    await expect(stat(path.join(pool, "Linked"))).rejects.toThrow();

    const wide = path.join(hdd, "Wide");
    await mkdir(wide, { recursive: true });
    await writeFile(path.join(wide, "Wide.exe"), "x");
    for (let index = 0; index < 200; index += 1) await writeFile(path.join(wide, `f${index}.bin`), "x");
    const many = await addShelfGame({ path: wide, pool, name: "Wide" }, data);
    await expect(wantToPlay(many.game.id, data)).rejects.toThrow(/Оригинал не трогался/);
    expect(await readFile(path.join(wide, "Wide.exe"), "utf8")).toBe("x");
  });

  it("launches the configured emulator and nothing else", async () => {
    const { data, pool, hdd } = await workspace();
    const source = path.join(hdd, "PSP", "Chains");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "ULUS10353.iso"), "iso");
    const emulator = path.join(hdd, "PPSSPP");
    await writeFile(emulator, "emu");
    await saveShelfTools({ ppsspp: emulator }, data);
    const added = await addShelfGame({ path: source, pool, name: "Chains of Olympus" }, data);
    expect(added.game.platform).toBe("psp");
    const calls: string[][] = [];
    const launched = await launchShelfGame(added.game.id, data, (file, args) => {
      calls.push([file, ...args]);
    });
    expect(launched.launched).toBe(true);
    expect(launched.button.kind).toBe("emulator");
    expect(launched.button.machineLabel).toBe("Mac");
    expect(calls).toEqual([[emulator, path.join(source, "ULUS10353.iso")]]);
  });
});
