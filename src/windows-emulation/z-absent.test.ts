import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { browseRoots } from "@/addons/drives/browse";
import { displayDiskPickerLabel, displayDiskTitle, isStripDisk } from "@/addons/drives/inventory";
import { selectIndexStrategy } from "@/addons/drives/strategy";
import { lettersToProbe, matchesExcluded, parseVolumeGuard } from "@/addons/drives/volume-guard";
import { parseWindowsVolumes, windowsSkipNote } from "@/addons/drives/win-volumes";
import { readNtfsLetter } from "../../agents/lib/indexers.mts";
import { reconcileProtocol } from "@/lib/torrents/reconcile";
import { assertEncodePaths } from "@/lib/transcode/encode-plan";
import { storageRole } from "@/lib/policies/storage-roles";
import {
  PRESENT_LETTERS,
  Z_CONTENT_MARKER,
  Z_SERIAL,
  Z_UUID,
  emulatedCatalog,
  emulatedWindowsReport,
  leakedZReport,
} from "@/windows-emulation/world";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("emulated Windows without Z:", () => {
  it("keeps only the attached letters and never stores the leaked volume contents", () => {
    const guard = parseVolumeGuard({
      exclude: ["Z"],
      known: [{ letter: "Z", serial: Z_SERIAL, volumeUuid: Z_UUID }],
    });
    const present = parseWindowsVolumes(emulatedWindowsReport(), {
      excludeLetters: [...guard.excludeLetters],
      excludeUuids: [...guard.excludeUuids],
      excludeSerials: [...guard.excludeSerials],
    });
    expect(present.volumes.map((volume) => volume.letter)).toEqual([...PRESENT_LETTERS]);
    expect(JSON.stringify(present.volumes)).not.toContain(Z_CONTENT_MARKER);
    expect(JSON.stringify(present.volumes)).not.toContain(Z_SERIAL);

    const leaked = parseWindowsVolumes(leakedZReport(), {
      excludeLetters: [...guard.excludeLetters],
      excludeUuids: [...guard.excludeUuids],
      excludeSerials: [...guard.excludeSerials],
    });
    expect(leaked.volumes.map((volume) => volume.letter)).toEqual([...PRESENT_LETTERS]);
    const dumped = JSON.stringify(leaked);
    expect(dumped).not.toContain(Z_CONTENT_MARKER);
    expect(dumped).not.toContain(Z_SERIAL);
    expect(dumped).not.toContain(Z_UUID);
    expect(matchesExcluded(guard, { letter: "Z", serial: "other", volumeUuid: "11111111-1111-4111-8111-111111111111" })).toBe(true);
    expect(lettersToProbe([...PRESENT_LETTERS, "Z", "z:"], [...guard.excludeLetters])).toEqual([...PRESENT_LETTERS]);
  });

  it("records that Z: has no volume and does not name anything that was on it", () => {
    const parsed = parseWindowsVolumes(emulatedWindowsReport());
    const note = windowsSkipNote(emulatedWindowsReport(), parsed.volumes);
    expect(note).toMatch(/Z/);
    expect(note).not.toContain(Z_CONTENT_MARKER);
    expect(parsed.volumes.some((volume) => volume.letter === "Z")).toBe(false);
  });

  it("refuses to open Z: for NTFS, encode, and torrent reconcile", async () => {
    const previous = process.env.SKLAD_EXCLUDE_LETTERS;
    process.env.SKLAD_EXCLUDE_LETTERS = "Z";
    try {
      await expect(readNtfsLetter("Z")).rejects.toThrow(/Том исключён до открытия устройства/);
    } finally {
      if (previous === undefined) delete process.env.SKLAD_EXCLUDE_LETTERS;
      else process.env.SKLAD_EXCLUDE_LETTERS = previous;
    }

    expect(() => assertEncodePaths([`Z:\\${Z_CONTENT_MARKER}`])).toThrow(/E и Z не открываются/);
    expect(selectIndexStrategy({ filesystem: "NTFS", platform: "win32", elevated: true }).strategy).toBe("mft-usn");
    expect(storageRole({ os: "win32", letter: "Z" })).toBe("forbidden");
    expect(storageRole({ os: "win32", letter: "D" })).toBe("cold-archive");

    const dir = await mkdtemp(path.join(os.tmpdir(), "sklad-z-"));
    dirs.push(dir);
    const result = await reconcileProtocol(
      dir,
      {
        hostId: "pc-agent",
        os: "win32",
        torrents: [
          {
            hash: "ab".repeat(20),
            name: "sealed",
            progress: 1,
            state: "uploading",
            ratio: 1,
            downloaded: 10,
            uploaded: 10,
            addedOn: 1,
            completionOn: 1,
            savePath: "Z:\\",
            files: [{ name: Z_CONTENT_MARKER, size: 4, progress: 1 }],
          },
        ],
      },
      [],
      1_700_000_000,
    );
    expect(result).toEqual({ enqueued: 0, blocked: 1 });
    const notes = await readFile(path.join(dir, "torrent-notes.json"), "utf8");
    expect(notes).not.toContain(Z_CONTENT_MARKER);
    expect(notes).toMatch(/не открываются/);
  });

  it("does not put Z: or the recovery volume on the disk strip", () => {
    const disks = emulatedCatalog();
    const strip = disks.filter((disk) => isStripDisk({
      id: disk.id,
      label: disk.label,
      volumeName: disk.volumeName,
      lastMountPath: disk.lastMountPath,
      mountPaths: [disk.lastMountPath],
      fileCount: disk.files.length,
      totalBytes: disk.totalBytes,
      online: disk.connectedHosts.length > 0,
      filesystem: disk.filesystem,
      serial: disk.serial,
      lastHostId: disk.lastHostId,
    }, disks));
    expect(strip.map((disk) => disk.label).sort()).toEqual(["games", "vault"]);
    const vault = strip.find((disk) => disk.id === "disk-d");
    expect(vault).toBeTruthy();
    const face = { ...vault!, mountPaths: [vault!.lastMountPath] };
    expect(displayDiskTitle(face)).toContain("ТБ");
    expect(displayDiskTitle(face)).toContain("D:");
    expect(displayDiskPickerLabel(face)).toContain("свободно");
    const roots = browseRoots(disks);
    expect(roots.entries.map((entry) => entry.name)).not.toContain("Z:");
    expect(JSON.stringify(roots)).not.toContain(Z_CONTENT_MARKER);
  });
});
