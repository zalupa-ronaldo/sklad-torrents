import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOCK_VAULT } from "@/addons/drives/mock-source";
import { getShelf, ingestObservation, renameDisk, searchShelf } from "@/addons/drives/service";
import { readCatalog } from "@/addons/drives/store";

let directory = "";
let previous: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sklad-drives-"));
  previous = process.env.SKLAD_DATA_DIR;
  process.env.SKLAD_DATA_DIR = directory;
  delete process.env.SKLAD_DRIVE_MODE;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.SKLAD_DATA_DIR;
  else process.env.SKLAD_DATA_DIR = previous;
  await rm(directory, { recursive: true, force: true });
});

describe("drive shelf service", () => {
  it("persists the shelf, a rename, and a replug of the same disk", async () => {
    const first = await getShelf();
    expect(first.mode).toBe("mock");
    expect(first.readOnly).toBe(true);
    const vaults = first.disks.filter((disk) => disk.serial === MOCK_VAULT.serial);
    expect(vaults).toHaveLength(1);
    expect(first.disks.some((disk) => disk.label === "Архив 2019" && !disk.online)).toBe(true);
    expect(first.disks.some((disk) => disk.online)).toBe(true);

    const renamed = await renameDisk(vaults[0].id, "Фильмы");
    expect(renamed.label).toBe("Фильмы");
    const again = await getShelf();
    expect(again.disks.find((disk) => disk.id === vaults[0].id)?.label).toBe("Фильмы");

    const replugged = await ingestObservation({
      hostId: "mac-mini",
      hostName: "Mac mini",
      os: "darwin",
      elevated: true,
      volumes: [
        {
          serial: MOCK_VAULT.serial,
          volumeUuid: MOCK_VAULT.volumeUuid,
          filesystem: "APFS",
          volumeName: "Vault",
          mountPaths: ["/Volumes/vault 9"],
          totalBytes: MOCK_VAULT.totalBytes,
          freeBytes: MOCK_VAULT.freeBytes,
          busy: false,
        },
      ],
    });
    expect(replugged.disks.filter((disk) => disk.serial === MOCK_VAULT.serial)).toHaveLength(1);
    expect(replugged.disks.find((disk) => disk.serial === MOCK_VAULT.serial)?.mountPaths).toEqual(["/Volumes/vault 9"]);
    expect(replugged.disks.find((disk) => disk.serial === MOCK_VAULT.serial)?.label).toBe("Фильмы");

    const stored = await readCatalog();
    expect(stored?.disks.filter((disk) => disk.serial === MOCK_VAULT.serial)).toHaveLength(1);
    const hits = await searchShelf("день рождения");
    expect(hits.hits[0]?.connectHint).toBe("Подключите диск «Архив 2019»");
    expect(hits.hits[0]?.reachable).toBe(false);
  });
});
