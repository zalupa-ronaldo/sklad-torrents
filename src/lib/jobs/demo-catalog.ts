import type { JobHost } from "@/lib/jobs/model";

export interface DemoDisk {
  id: string;
  host: JobHost;
  label: string;
  path: string;
}

export interface DemoFile {
  id: string;
  host: JobHost;
  diskId: string;
  name: string;
  path: string;
  bytes: number;
}

export const DEMO_DISKS: DemoDisk[] = [
  { id: "vault", host: "mac-local", label: "Vault", path: "/Volumes/vault" },
  { id: "cinema", host: "mac-local", label: "Cinema", path: "/Volumes/vault/Cinema/Watched" },
  { id: "psp", host: "mac-local", label: "PSP", path: "/Volumes/vault/PSP/Games" },
  { id: "downloads-mac", host: "mac-local", label: "Загрузки Mac", path: "/Volumes/vault/Downloads" },
  { id: "d-games", host: "pc-agent", label: "D: Games", path: "D:\\Games" },
  { id: "d-downloads", host: "pc-agent", label: "D: Downloads", path: "D:\\Downloads" },
  { id: "e-archive", host: "pc-agent", label: "E: Archive", path: "E:\\Archive" },
  { id: "e-cinema", host: "pc-agent", label: "E: Cinema", path: "E:\\Cinema" },
];

const MAC_NAMES = [
  "Interstellar.2014.2160p.mkv",
  "Blade.Runner.2049.mkv",
  "Dune.Part.Two.2160p.mkv",
  "The.Matrix.1999.2160p.mkv",
  "Arrival.2016.1080p.mkv",
  "NieR.Automata.OST.flac",
  "God.of.War.PSP.iso",
  "Control.Ultimate.Edition.pkg",
];

const PC_NAMES = [
  "Control.Ultimate.7z",
  "Blender.4.2.msi",
  "Ubuntu.24.04.iso",
  "Archive.2024.part01.rar",
  "Notes.txt",
  "Family.2018.mov",
  "Backup.vhdx",
  "Manual.pdf",
];

function macPath(disk: DemoDisk, name: string): string {
  return `${disk.path}/${name}`;
}

function pcPath(disk: DemoDisk, name: string): string {
  return `${disk.path}\\${name}`;
}

export const DEMO_FILES: DemoFile[] = [
  ...MAC_NAMES.flatMap((name, index) => {
    const disk = DEMO_DISKS[index % 4];
    return [
      {
        id: `mac-${index}`,
        host: "mac-local" as const,
        diskId: disk.id,
        name,
        path: macPath(disk, name),
        bytes: 800_000_000 + index * 125_000_000,
      },
    ];
  }),
  ...PC_NAMES.flatMap((name, index) => {
    const disk = DEMO_DISKS[4 + (index % 4)];
    return [
      {
        id: `pc-${index}`,
        host: "pc-agent" as const,
        diskId: disk.id,
        name,
        path: pcPath(disk, name),
        bytes: 400_000_000 + index * 90_000_000,
      },
    ];
  }),
];

export const DISK_PAGE_SIZE = 4;
export const FILE_PAGE_SIZE = 8;
export const JOB_PAGE_SIZE = 8;

export function pageSlice<T>(items: T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const start = safePage * size;
  return { items: items.slice(start, start + size), page: safePage, pages };
}
