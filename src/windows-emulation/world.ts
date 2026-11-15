import type { DiskRecord, IndexedFile } from "@/addons/drives/types";
import type { WindowsVolumeReport } from "@/addons/drives/win-volumes";
import type { EncodeHost } from "@/lib/transcode/assign";

/** Emulated DESKTOP-OLT9HAV. Drive Z: is not attached. */
export const PC = { id: "pc-agent", name: "DESKTOP-OLT9HAV", os: "win32" as const };
export const MAC = { id: "mac-local", name: "mac-local", os: "darwin" as const };

export const Z_SERIAL = "WRA04CK7";
export const Z_UUID = "d5625324-d816-4af6-9504-66b4639e2309";
/** A name that must never appear in a parsed inventory or a reconcile note. */
export const Z_CONTENT_MARKER = "z-secret-ledger.txt";

export const PRESENT_LETTERS = ["C", "D", "E", "F", "S"] as const;

const TB = 1024 ** 4;
const GB = 1024 ** 3;

interface VolumeSpec {
  letter: string;
  label: string;
  serial: string;
  uuid: string;
  bytes: number;
  free: number;
  filesystem?: string;
}

const PRESENT_VOLUMES: VolumeSpec[] = [
  { letter: "C", label: "Windows", serial: "C-SERIAL", uuid: "11111111-1111-4111-8111-111111111111", bytes: 512 * GB, free: 180 * GB },
  { letter: "D", label: "vault", serial: "D-SERIAL", uuid: "22222222-2222-4222-8222-222222222222", bytes: TB, free: 400 * GB },
  { letter: "E", label: "archive", serial: "E-SERIAL", uuid: "33333333-3333-4333-8333-333333333333", bytes: 2 * TB, free: 900 * GB },
  { letter: "F", label: "virtual", serial: "F-SERIAL", uuid: "44444444-4444-4444-8444-444444444444", bytes: 64 * GB, free: 64 * GB },
  { letter: "S", label: "games", serial: "S-SERIAL", uuid: "55555555-5555-4555-8555-555555555555", bytes: 8 * TB, free: TB },
];

function volumeRow(spec: VolumeSpec) {
  return {
    DriveLetter: spec.letter,
    FileSystem: spec.filesystem ?? "NTFS",
    FileSystemLabel: spec.label,
    Size: spec.bytes,
    SizeRemaining: spec.free,
    UniqueId: `\\\\?\\Volume{${spec.uuid}}\\`,
  };
}

/** Windows volume report for a machine that has no Z: drive. */
export function emulatedWindowsReport(): WindowsVolumeReport {
  return {
    admin: true,
    disks: PRESENT_VOLUMES.map((spec, index) => ({ Index: index, SerialNumber: spec.serial, Size: spec.bytes })),
    parts: PRESENT_VOLUMES.map((spec, index) => ({ DiskNumber: index, DriveLetter: spec.letter })),
    vols: PRESENT_VOLUMES.map(volumeRow),
    perf: [],
    skipped: [{ letter: "Z", kind: "absent", message: "volume not mounted" }],
  };
}

/** A leaked inventory row. Parsers must drop it before any content is kept. */
export function leakedZReport(): WindowsVolumeReport {
  const clean = emulatedWindowsReport();
  return {
    ...clean,
    disks: [...(clean.disks as object[]), { Index: 9, SerialNumber: Z_SERIAL, Size: 4 * TB }],
    parts: [...(clean.parts as object[]), { DiskNumber: 9, DriveLetter: "Z" }],
    vols: [
      ...(clean.vols as object[]),
      volumeRow({
        letter: "Z",
        label: Z_CONTENT_MARKER,
        serial: Z_SERIAL,
        uuid: Z_UUID,
        bytes: 4 * TB,
        free: TB,
      }),
    ],
    perf: [{ Name: "Z:", PercentDiskTime: 90 }],
  };
}

export function file(relativePath: string, size: number, categories: IndexedFile["categories"] = []): IndexedFile {
  const name = relativePath.split("/").pop() || relativePath;
  return {
    relativePath,
    name,
    kind: "file",
    size,
    mtimeMs: 1_700_000_000_000,
    sidecarCategory: null,
    categories,
  };
}

export function diskRecord(input: {
  id: string;
  letter: string;
  label: string;
  bytes: number;
  free: number;
  files: IndexedFile[];
  online?: boolean;
  filesystem?: string;
}): DiskRecord {
  const mount = `${input.letter}:\\`;
  const online = input.online !== false;
  return {
    id: input.id,
    serial: `${input.letter}-SERIAL`,
    serialNorm: `${input.letter}-serial`,
    volumeUuid: `${input.letter.toLowerCase()}-uuid`,
    uuidNorm: `${input.letter.toLowerCase()}-uuid`,
    filesystem: input.filesystem ?? "NTFS",
    label: input.label,
    namedByUser: false,
    volumeName: input.label,
    totalBytes: input.bytes,
    freeBytes: input.free,
    lastSeenAt: "2026-11-15T00:00:00.000Z",
    lastHostId: PC.id,
    lastHostName: PC.name,
    pathStyle: "win32",
    lastMountPath: mount,
    priorMountPath: "",
    connectedHosts: online ? [{ id: PC.id, name: PC.name, os: "win32", elevated: true, mountPaths: [mount] }] : [],
    duplicateMounts: false,
    possibleClone: false,
    cloneOfIds: [],
    scan: { status: "complete", strategy: "mft-usn", progress: 1, message: "mft", elevated: true },
    files: input.files,
    indexRevision: `rev-${input.id}`,
  };
}

/** Catalog the panel would show: vault online, games offline, recovery hidden by the strip filter. */
export function emulatedCatalog(): DiskRecord[] {
  return [
    diskRecord({
      id: "disk-d",
      letter: "D",
      label: "vault",
      bytes: TB,
      free: 400 * GB,
      files: [
        file("фильмы/Interstellar.mkv", 2_000_000_000, ["media"]),
        file("сериалы/Show.S01E01.mkv", 800_000_000, ["series"]),
        file("мультфильмы/Cartoon.mkv", 500_000_000, ["media"]),
        file("музыка/track.flac", 40_000_000, ["music"]),
        file("софт/setup.msi", 80_000_000, ["software"]),
        file("документы/notes.pdf", 200_000, ["documents"]),
        file("игры/Hades/Hades.exe", 90_000_000, ["game"]),
      ],
    }),
    diskRecord({
      id: "disk-s",
      letter: "S",
      label: "games",
      bytes: 8 * TB,
      free: TB,
      online: false,
      files: [file("игры/ColdGame/game.exe", 50_000_000, ["game"])],
    }),
    diskRecord({
      id: "disk-recovery",
      letter: "R",
      label: "Recovery",
      bytes: 500_000_000,
      free: 100_000_000,
      files: [],
    }),
  ];
}

/** Mac VideoToolbox and the Windows AMD RX 9070 XT probe. Functional AV1 is off: the smoke exits 3221225477. */
export const MAC_HANDBRAKE: EncodeHost = {
  id: MAC.id,
  os: "darwin",
  slots: 1,
  probe: {
    hardwareAv1: false,
    videoToolbox: { h264: true, hevc: true, av1: false },
    amf: null,
    encoders: ["vt_h264", "vt_h265", "x264", "x265", "svt_av1"],
  },
};

export const WINDOWS_HANDBRAKE: EncodeHost = {
  id: PC.id,
  os: "win32",
  slots: 1,
  probe: {
    hardwareAv1: false,
    videoToolbox: null,
    amf: { h264: true, hevc: true, av1: false },
    encoders: ["vce_h264", "vce_h265", "vce_av1", "vce_av1_10bit", "x264", "x265", "svt_av1", "svt_av1_10bit"],
  },
};

export const HANDBRAKE_HELP = [
  "HandBrake 1.11.1",
  "Select video encoder:",
  "svt_av1",
  "svt_av1_10bit",
  "vce_av1",
  "vce_av1_10bit",
  "x264",
  "x265",
  "x265_10bit",
  "",
  "    copy",
  "--markers",
  "--subtitle",
].join("\n");

export const MEDIA_FACTS = {
  format: "matroska",
  duration: 120,
  videoCodec: "hevc",
  audio: 1,
  subtitles: 1,
  chapters: 2,
  hdr: false,
};
