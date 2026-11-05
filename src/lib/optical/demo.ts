import type { IndexedPath, OpticalDrive } from "@/lib/optical/media";

/** Catalog-shaped stand-in used when Drive Manager has not indexed disks yet. */
export function demoIndexedPaths(): IndexedPath[] {
  return [
    {
      diskLabel: "Vault",
      path: "/Volumes/vault/Music/NieR Automata OST/booklet.pdf",
      name: "booklet.pdf",
      size: 12_000_000,
      kind: "file",
    },
    {
      diskLabel: "Vault",
      path: "/Volumes/vault/Music/NieR Automata OST",
      name: "NieR Automata OST",
      size: 122_000_000,
      kind: "folder",
    },
    {
      diskLabel: "Vault",
      path: "/Volumes/vault/Cinema/Season",
      name: "Сезон",
      size: 800 * 1024 * 1024,
      kind: "folder",
    },
    {
      diskLabel: "Vault",
      path: "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
      name: "Interstellar.2014.2160p.mkv",
      size: 62_400_000_000,
      kind: "file",
    },
  ];
}

/**
 * Mock drives for the demo toggle / SKLAD_OPTICAL_DEMO.
 * hardwareSerial is always null: a demo must not invent a drive serial.
 */
export function demoDrives(): OpticalDrive[] {
  return [
    {
      id: "demo-internal-rw",
      name: "Внутренний DVD±RW",
      device: "/dev/disk2",
      driveIndex: "1",
      location: "internal",
      media: "dvd-rw",
      volumeName: null,
      volumeUuid: null,
      hardwareSerial: null,
      rewritable: true,
      suggestedProfile: "dvd-sl",
      demo: true,
      platform: "darwin",
      recorderId: null,
    },
    {
      id: "demo-external-dl",
      name: "Внешний DVD±R DL",
      device: "E:",
      driveIndex: null,
      location: "external",
      media: "empty",
      volumeName: null,
      volumeUuid: null,
      hardwareSerial: null,
      rewritable: false,
      suggestedProfile: "dvd-dl",
      demo: true,
      platform: "win32",
      recorderId: "E:",
    },
  ];
}
