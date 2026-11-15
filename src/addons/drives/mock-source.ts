import { reconcileCatalog } from "@/addons/drives/reconcile";
import { MOCK_ARCHIVE, MOCK_BACKUP, MOCK_GAMES, MOCK_IDS, MOCK_VAULT } from "@/addons/drives/mock-ids";
import type { DiskRecord, HostObservation, IndexPayload, LibraryRule, RawIndexedFile } from "@/addons/drives/types";

export { MOCK_ARCHIVE, MOCK_BACKUP, MOCK_GAMES, MOCK_IDS, MOCK_VAULT };

const FILE = (relativePath: string, size: number, extra?: Pick<RawIndexedFile, "onDisk" | "compression">): RawIndexedFile => ({
  relativePath,
  name: relativePath.split("/").pop() ?? relativePath,
  kind: "file",
  size,
  mtimeMs: Date.parse("2026-04-01T00:00:00.000Z"),
  ...extra,
});

const DIR = (relativePath: string): RawIndexedFile => ({
  relativePath,
  name: relativePath.split("/").pop() ?? relativePath,
  kind: "dir",
  size: 0,
  mtimeMs: Date.parse("2026-04-01T00:00:00.000Z"),
});

export function vaultFiles(): RawIndexedFile[] {
  return [
    DIR("Cinema"),
    FILE("Cinema/Interstellar.2014.2160p.mkv", 62_400_000_000),
    DIR("PSP/Games/Downloads"),
    FILE("PSP/Games/Downloads/God of War (PSP)/ISO/ULUS10479.iso", 1_400_000_000),
    DIR("Downloads"),
    FILE("Downloads/ubuntu-24.04.3-desktop-amd64.iso", 5_800_000_000),
    DIR("Music"),
    FILE("Music/NieR Automata OST/01 - Significance.flac", 42_000_000),
  ];
}

export function archiveFiles(): RawIndexedFile[] {
  return [
    DIR("Archive"),
    DIR("Archive/Семейный архив 2019"),
    FILE("Archive/Семейный архив 2019/2019-07/IMG_2041.jpg", 4_000_000),
    FILE("Archive/Семейный архив 2019/видео/день рождения.mp4", 8_000_000_000),
    {
      ...FILE("Archive/Семейный архив 2019/sklad-catalog.json", 64),
      sidecarCategory: "media",
    },
  ];
}

export function gamesFiles(): RawIndexedFile[] {
  return [
    DIR("Games"),
    FILE("Games/Control Ultimate Edition/Control_DX12.exe", 80_000_000, { onDisk: 80_000_000 }),
    FILE("Games/Control Ultimate Edition/data/pack0.pack", 8_000_000_000, { onDisk: 5_200_000_000, compression: "wof" }),
  ];
}

function done(files: RawIndexedFile[]): IndexPayload {
  return { state: "complete", progress: 1, files };
}

function volume(
  disk: { serial: string; volumeUuid: string; filesystem: string; volumeName: string; totalBytes: number; freeBytes: number },
  mountPaths: string[],
  extra?: { busy?: boolean; index?: IndexPayload | null },
) {
  return {
    serial: disk.serial,
    volumeUuid: disk.volumeUuid,
    filesystem: disk.filesystem,
    volumeName: disk.volumeName,
    mountPaths,
    totalBytes: disk.totalBytes,
    freeBytes: disk.freeBytes,
    busy: extra?.busy ?? false,
    index: extra?.index,
  };
}

function mac(volumes: HostObservation["volumes"]): HostObservation {
  return { hostId: MOCK_IDS.mac, hostName: "Mac mini", os: "darwin", elevated: true, volumes };
}

function windows(volumes: HostObservation["volumes"], elevated = false): HostObservation {
  return { hostId: MOCK_IDS.windows, hostName: "Windows PC", os: "win32", elevated, volumes };
}

export interface MockStep {
  at: string;
  observations: HostObservation[];
}

/** Scripted attach, replug on another mount, and an offline disk that stays in the catalog. */
export function mockSteps(): MockStep[] {
  return [
    {
      at: "2026-06-01T10:00:00.000Z",
      observations: [mac([volume(MOCK_VAULT, ["/Volumes/vault"], { index: done(vaultFiles()) })])],
    },
    { at: "2026-06-02T10:00:00.000Z", observations: [mac([])] },
    {
      at: "2026-06-03T10:00:00.000Z",
      observations: [mac([volume(MOCK_VAULT, ["/Volumes/vault 1"], { index: done(vaultFiles()) })])],
    },
    {
      at: "2026-08-19T15:00:00.000Z",
      observations: [windows([volume(MOCK_ARCHIVE, ["E:\\"], { index: done(archiveFiles()) })])],
    },
    { at: "2026-08-20T09:00:00.000Z", observations: [windows([])] },
    {
      at: "2026-11-01T12:00:00.000Z",
      observations: [windows([volume(MOCK_GAMES, ["D:\\"], { index: done(gamesFiles()) })])],
    },
    {
      at: "2026-11-05T18:00:00.000Z",
      observations: liveObservations(),
    },
  ];
}

export function liveObservations(): HostObservation[] {
  return [
    mac([
      volume(MOCK_VAULT, ["/Volumes/vault 1"]),
      volume(MOCK_BACKUP, ["/Volumes/BACKUP"], {
        index: { state: "running", progress: 0.4, strategy: "walk" },
      }),
    ]),
    windows([
      volume(MOCK_GAMES, ["D:\\"], {
        index: { state: "running", progress: 0.62, strategy: "walk" },
      }),
    ]),
  ];
}

export function buildMockCatalog(libraries: readonly LibraryRule[]): DiskRecord[] {
  let disks: DiskRecord[] = [];
  for (const step of mockSteps()) {
    disks = reconcileCatalog(disks, step.observations, libraries, step.at);
  }
  return disks;
}
