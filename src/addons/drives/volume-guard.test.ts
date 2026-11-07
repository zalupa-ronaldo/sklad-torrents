import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeIndexPlan } from "@/addons/drives/execute-index";
import { normalizeUuid } from "@/addons/drives/identity";
import { WINDOWS_VOLUME_SCRIPT } from "@/addons/drives/win-script";
import { parseWindowsVolumes } from "@/addons/drives/win-volumes";
import { readNtfsLetter, readUsn } from "../../../agents/lib/indexers.mts";
import {
  lettersToProbe,
  matchesExcluded,
  parseVolumeGuard,
} from "@/addons/drives/volume-guard";

const Z_UUID = "d5625324-d816-4af6-9504-66b4639e2309";
const savedExclude = process.env.SKLAD_EXCLUDE_LETTERS;

afterEach(() => {
  if (savedExclude === undefined) delete process.env.SKLAD_EXCLUDE_LETTERS;
  else process.env.SKLAD_EXCLUDE_LETTERS = savedExclude;
});

describe("volume guard", () => {
  it("excludes the known letter before serial or uuid can be used as a probe", () => {
    const guard = parseVolumeGuard({
      letters: ["Z", "D"],
      exclude: ["Z"],
      known: [{ letter: "Z", serial: "WRA04CK7", volumeUuid: Z_UUID }],
    });
    expect([...guard.excludeLetters]).toEqual(["Z"]);
    expect([...guard.manualOnly]).toEqual(["D"]);
    expect(guard.excludeSerials.has("WRA04CK7")).toBe(true);
    expect([...guard.excludeUuids]).toEqual([normalizeUuid(Z_UUID)]);
    expect(lettersToProbe(["C", "D", "E", "F", "S", "Z", "z:"], [...guard.excludeLetters])).toEqual(["C", "D", "E", "F", "S"]);
    expect(matchesExcluded(guard, { letter: "Z", serial: "other", volumeUuid: "11111111-1111-4111-8111-111111111111" })).toBe(true);
    expect(matchesExcluded(guard, { letter: "C", serial: "WRA04CK7", volumeUuid: "11111111-1111-4111-8111-111111111111" })).toBe(true);
    expect(matchesExcluded(guard, { letter: "C", serial: "C-SERIAL", volumeUuid: Z_UUID })).toBe(true);
    expect(matchesExcluded(guard, { letter: "S", serial: "S-SERIAL", volumeUuid: "22222222-2222-4222-8222-222222222222" })).toBe(false);
  });

  it("keeps manualOnly separate from exclude", () => {
    const guard = parseVolumeGuard({ letters: ["Z"], exclude: [] });
    expect([...guard.manualOnly]).toEqual(["Z"]);
    expect(guard.excludeLetters.size).toBe(0);
    expect(lettersToProbe(["C", "Z"], [...guard.excludeLetters])).toEqual(["C", "Z"]);
  });

  it("puts the letter gate before every volume, partition, and CIM query", () => {
    const script = WINDOWS_VOLUME_SCRIPT;
    const gate = script.indexOf("$exclude");
    const registry = script.indexOf("MountedDevices");
    const probes = [...script.matchAll(/Get-Volume|Get-Partition|Get-CimInstance/g)];
    expect(probes.length).toBe(4);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(registry).toBeGreaterThan(gate);
    for (const probe of probes) expect(probe.index ?? 0).toBeGreaterThan(registry);
    for (const line of script.split("\n")) {
      if (line.includes("Get-Volume")) expect(line).toContain("-DriveLetter");
      if (line.includes("Get-Partition")) expect(line).toContain("-DriveLetter");
      if (line.includes("Win32_DiskDrive")) expect(line).toContain("-Filter");
      if (line.includes("LogicalDisk")) expect(line).toContain("-Filter");
    }
    expect(script).not.toMatch(/Where-Object/);
    expect(script).not.toMatch(/Get-Volume(?! -DriveLetter)/);
    expect(script).not.toMatch(/Get-Partition(?! -DriveLetter)/);
    expect(script).not.toMatch(/Win32_DiskDrive(?! -Filter)/);
    expect(script).not.toMatch(/LogicalDisk(?! -Filter)/);
    expect(script).not.toMatch(/Z:/);
    expect(script).toContain("SKLAD_EXCLUDE_LETTERS");
    expect(script).toContain("'HKLM:\\SYSTEM\\MountedDevices'");
    expect(script).toContain("'\\\\DosDevices\\\\([A-Z]):$'");
  });

  it("refuses Z inside every PowerShell device script before CreateFile", () => {
    const usn = readFileSync(path.join(process.cwd(), "agents/pc-agent/win32/usn.ps1"), "utf8");
    const ntfs = readFileSync(path.join(process.cwd(), "agents/pc-agent/win32/ntfs.ts"), "utf8");
    const indexers = readFileSync(path.join(process.cwd(), "agents/lib/indexers.mts"), "utf8");
    const collect = readFileSync(path.join(process.cwd(), "agents/pc-agent/collect.mts"), "utf8");
    expect(usn.indexOf("SKLAD_EXCLUDE_LETTERS")).toBeGreaterThan(0);
    expect(usn.indexOf("SKLAD_EXCLUDE_LETTERS")).toBeLessThan(usn.indexOf("CreateFileW("));
    expect(usn).not.toMatch(/\\\\\.\\Z:/);
    expect(ntfs.indexOf("assertLetterAllowed")).toBeLessThan(ntfs.indexOf("spawn("));
    expect(indexers.indexOf("assertLetterAllowed")).toBeLessThan(indexers.indexOf("open("));
    expect(indexers.indexOf("assertLetterAllowed")).toBeLessThan(indexers.indexOf("fsutil"));
    expect(collect).toContain("timeout: 120_000");
    expect(collect).toContain("SKLAD_EXCLUDE_LETTERS: [...guard.excludeLetters].join");
    expect(collect).not.toMatch(/-Command",\s*`/);
  });

  it("does not open an excluded letter from the NTFS readers", async () => {
    process.env.SKLAD_EXCLUDE_LETTERS = "Z";
    await expect(readNtfsLetter("Z")).rejects.toThrow(/Том исключён до открытия устройства/);
    await expect(readUsn("Z", null)).rejects.toThrow(/Том исключён до открытия устройства/);
    let allowed = "";
    try {
      await readNtfsLetter("C");
    } catch (error) {
      allowed = error instanceof Error ? error.message : String(error);
    }
    expect(allowed).not.toMatch(/Том исключён/);
    expect(allowed.length).toBeGreaterThan(0);
  });

  it("drops a leaked Z record and still parses C/D/E/F/S", () => {
    const report = {
      admin: true,
      disks: [
        { Index: 0, SerialNumber: "C-SERIAL", Size: 100 },
        { Index: 1, SerialNumber: "D-SERIAL", Size: 100 },
        { Index: 2, SerialNumber: "E-SERIAL", Size: 100 },
        { Index: 3, SerialNumber: "F-SERIAL", Size: 100 },
        { Index: 4, SerialNumber: "S-SERIAL", Size: 100 },
        { Index: 5, SerialNumber: "WRA04CK7", Size: 100 },
      ],
      parts: ["C", "D", "E", "F", "S", "Z"].map((letter, index) => ({ DiskNumber: index, DriveLetter: letter })),
      vols: ["C", "D", "E", "F", "S", "Z"].map((letter, index) => ({
        DriveLetter: letter,
        FileSystem: "NTFS",
        FileSystemLabel: letter,
        Size: 100,
        SizeRemaining: 10,
        UniqueId: letter === "Z" ? `\\\\?\\Volume{${Z_UUID}}\\` : `\\\\?\\Volume{00000000-0000-4000-8000-00000000000${index}}\\`,
      })),
      perf: [{ Name: "Z:", PercentDiskTime: 90 }],
    };
    const parsed = parseWindowsVolumes(report, {
      excludeLetters: ["Z"],
      excludeUuids: [Z_UUID],
      excludeSerials: ["WRA04CK7"],
    });
    expect(parsed.volumes.map((volume) => volume.letter)).toEqual(["C", "D", "E", "F", "S"]);
    expect(JSON.stringify(parsed.volumes)).not.toContain("WRA04CK7");
    expect(JSON.stringify(parsed.volumes)).not.toContain(Z_UUID);
  });

  it("does not walk the filesystem when the MFT read fails", async () => {
    const calls: string[] = [];
    const result = await executeIndexPlan(
      { filesystem: "NTFS", platform: "win32", elevated: true, busy: false, usnCheckpoint: false },
      {
        readMft: async () => {
          calls.push("readMft");
          throw new Error("mft failed");
        },
        readUsn: async () => {
          calls.push("readUsn");
          return { delta: null };
        },
        walk: async () => {
          calls.push("walk");
          return { files: [], complete: true };
        },
      },
    );
    expect(calls).toEqual(["readMft"]);
    expect(result.called).toEqual(["readMft"]);
    expect(result.payload.strategy).toBe("mft-usn");
    expect(result.payload.message).toMatch(/Обход папок не запускался/);
  });
});
