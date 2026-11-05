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
      id: "win-dvd-rw",
      name: "HL-DT-ST DVDRAM GP57ES60",
      device: "E:",
      driveIndex: null,
      location: "external",
      media: "dvd-rw",
      volumeName: null,
      volumeUuid: null,
      hardwareSerial: null,
      rewritable: true,
      suggestedProfile: "dvd-sl",
      demo: true,
      platform: "win32",
      recorderId: "E:",
    },
    {
      id: "win-dvd-r",
      name: "Optiarc DVD RW AD-7200S",
      device: "F:",
      driveIndex: null,
      location: "external",
      media: "dvd+r",
      volumeName: null,
      volumeUuid: null,
      hardwareSerial: null,
      rewritable: false,
      suggestedProfile: "dvd-sl",
      demo: true,
      platform: "win32",
      recorderId: "F:",
    },
  ];
}
