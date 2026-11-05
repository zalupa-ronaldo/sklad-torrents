import type { HostRecord } from "@/lib/qbittorrent/types";

export const DEMO_MAC_ID = "demo-mac";
export const DEMO_PC_ID = "demo-pc";

export const DEMO_HASH = {
  interstellar: "1111111111111111111111111111111111111111",
  godOfWar: "2222222222222222222222222222222222222222",
  soundtrack: "3333333333333333333333333333333333333333",
  ubuntu: "4444444444444444444444444444444444444444",
  control: "5555555555555555555555555555555555555555",
  blender: "6666666666666666666666666666666666666666",
  archive: "7777777777777777777777777777777777777777",
  dune: "8888888888888888888888888888888888888888",
  cyberpunk: "9999999999999999999999999999999999999999",
  vacation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

const NOW = 1_793_000_000;
const INFINITY_ETA = 8_640_000;

export interface SeedFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

export interface SeedTorrent {
  hash: string;
  name: string;
  rawState: string;
  progress: number;
  size: number;
  totalSize: number;
  downloaded: number;
  uploaded: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  ratio: number;
  savePath: string;
  contentPath: string;
  addedOn: number;
  completionOn: number;
  numSeeds: number;
  numLeechs: number;
  category: string;
  tags: string[];
  files: SeedFile[];
}

export function demoHosts(): HostRecord[] {
  return [
    {
      id: DEMO_MAC_ID,
      name: "Mac mini",
      kind: "mock",
      baseUrl: "mock://mac-mini",
      username: "demo",
      password: "",
      os: "darwin",
      pathPresets: [
        { id: "vault-downloads", label: "Vault · загрузки", path: "/Volumes/vault/Downloads" },
        { id: "vault-psp", label: "Vault · PSP", path: "/Volumes/vault/PSP/Games/Downloads" },
        { id: "vault-cinema", label: "Vault · кино", path: "/Volumes/vault/Cinema" },
        { id: "vault-music", label: "Vault · музыка", path: "/Volumes/vault/Music" },
      ],
    },
    {
      id: DEMO_PC_ID,
      name: "Windows PC",
      kind: "mock",
      baseUrl: "mock://windows-pc",
      username: "demo",
      password: "",
      os: "win32",
      pathPresets: [
        { id: "d-downloads", label: "Диск D · загрузки", path: "D:\\Downloads" },
        { id: "d-games", label: "Диск D · игры", path: "D:\\Games" },
        { id: "e-archive", label: "Диск E · архив", path: "E:\\Archive" },
      ],
    },
  ];
}

export function demoTorrents(hostId: string): SeedTorrent[] {
  if (hostId === DEMO_MAC_ID) return macTorrents();
  if (hostId === DEMO_PC_ID) return pcTorrents();
  return [];
}

function macTorrents(): SeedTorrent[] {
  return [
    {
      hash: DEMO_HASH.interstellar,
      name: "Интерстеллар (2014) 2160p UHD",
      rawState: "uploading",
      progress: 1,
      size: 62_400_000_000,
      totalSize: 62_400_000_000,
      downloaded: 62_400_000_000,
      uploaded: 262_080_000_000,
      dlspeed: 0,
      upspeed: 3_400_000,
      eta: INFINITY_ETA,
      ratio: 4.2,
      savePath: "/Volumes/vault/Cinema",
      contentPath: "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
      addedOn: NOW - 40 * 86_400,
      completionOn: NOW - 39 * 86_400,
      numSeeds: 18,
      numLeechs: 3,
      category: "cinema",
      tags: [],
      files: [
        {
          index: 0,
          name: "Interstellar.2014.2160p.mkv",
          size: 62_400_000_000,
          progress: 1,
          priority: 1,
        },
      ],
    },
    {
      hash: DEMO_HASH.godOfWar,
      name: "God of War (PSP)",
      rawState: "downloading",
      progress: 0,
      size: 0,
      totalSize: 0,
      downloaded: 0,
      uploaded: 80_000_000,
      dlspeed: 8_800_000,
      upspeed: 120_000,
      eta: 7_200,
      ratio: 0.04,
      savePath: "/Volumes/vault/PSP/Games/Downloads",
      contentPath: "/Volumes/vault/PSP/Games/Downloads/God of War (PSP)",
      addedOn: NOW - 2 * 86_400,
      completionOn: 0,
      numSeeds: 6,
      numLeechs: 2,
      category: "psp",
      tags: ["psp"],
      files: [
        {
          index: 0,
          name: "God of War (PSP)/ISO/ULUS10479.iso",
          size: 1_400_000_000,
          progress: 1,
          priority: 1,
        },
        {
          index: 1,
          name: "God of War (PSP)/ISO/ULES00157.iso",
          size: 1_400_000_000,
          progress: 0.4,
          priority: 1,
        },
        {
          index: 2,
          name: "God of War (PSP)/Cheats/cwcheat.ini",
          size: 2_048,
          progress: 1,
          priority: 1,
        },
        {
          index: 3,
          name: "God of War (PSP)/Cover/front.jpg",
          size: 400_000,
          progress: 1,
          priority: 1,
        },
        {
          index: 4,
          name: "God of War (PSP)/Cover/back.jpg",
          size: 400_000,
          progress: 0.25,
          priority: 1,
        },
      ],
    },
    {
      hash: DEMO_HASH.soundtrack,
      name: "NieR:Automata OST",
      rawState: "pausedUP",
      progress: 1,
      size: 1_100_000_000,
      totalSize: 1_100_000_000,
      downloaded: 1_100_000_000,
      uploaded: 40_000_000,
      dlspeed: 0,
      upspeed: 0,
      eta: INFINITY_ETA,
      ratio: 0.04,
      savePath: "/Volumes/vault/Music",
      contentPath: "/Volumes/vault/Music/NieR Automata OST",
      addedOn: NOW - 12 * 86_400,
      completionOn: NOW - 11 * 86_400,
      numSeeds: 0,
      numLeechs: 0,
      category: "music",
      tags: [],
      files: [
        { index: 0, name: "NieR Automata OST/01 - Significance.flac", size: 42_000_000, progress: 1, priority: 1 },
        { index: 1, name: "NieR Automata OST/02 - City Ruins.flac", size: 68_000_000, progress: 1, priority: 1 },
        { index: 2, name: "NieR Automata OST/booklet.pdf", size: 12_000_000, progress: 1, priority: 1 },
      ],
    },
    {
      hash: DEMO_HASH.ubuntu,
      name: "Ubuntu 24.04.3 desktop amd64",
      rawState: "stalledDL",
      progress: 0.12,
      size: 5_800_000_000,
      totalSize: 5_800_000_000,
      downloaded: 696_000_000,
      uploaded: 0,
      dlspeed: 0,
      upspeed: 0,
      eta: INFINITY_ETA,
      ratio: 0,
      savePath: "/Volumes/vault/Downloads",
      contentPath: "/Volumes/vault/Downloads/ubuntu-24.04.3-desktop-amd64.iso",
      addedOn: NOW - 3_600,
      completionOn: 0,
      numSeeds: 0,
      numLeechs: 1,
      category: "iso",
      tags: [],
      files: [
        {
          index: 0,
          name: "ubuntu-24.04.3-desktop-amd64.iso",
          size: 5_800_000_000,
          progress: 0.12,
          priority: 1,
        },
      ],
    },
    {
      hash: DEMO_HASH.dune,
      name: "Дюна (2021) 2160p",
      rawState: "pausedDL",
      progress: 0.08,
      size: 3_200_000_000,
      totalSize: 40_000_000_000,
      downloaded: 3_200_000_000,
      uploaded: 0,
      dlspeed: 0,
      upspeed: 0,
      eta: INFINITY_ETA,
      ratio: 0,
      savePath: "/Volumes/vault/Cinema",
      contentPath: "/Volumes/vault/Cinema/Dune.2021.2160p.mkv",
      addedOn: NOW - 86_400,
      completionOn: 0,
      numSeeds: 4,
      numLeechs: 1,
      category: "cinema",
      tags: [],
      files: [
        {
          index: 0,
          name: "Dune.2021.2160p.mkv",
          size: 40_000_000_000,
          progress: 0.08,
          priority: 1,
        },
      ],
    },
  ];
}

function pcTorrents(): SeedTorrent[] {
  return [
    {
      hash: DEMO_HASH.control,
      name: "Control Ultimate Edition",
      rawState: "downloading",
      progress: 0,
      size: 0,
      totalSize: 0,
      downloaded: 0,
      uploaded: 20_000_000,
      dlspeed: 1_500_000,
      upspeed: 40_000,
      eta: 50_000,
      ratio: 0.01,
      savePath: "D:\\Games",
      contentPath: "D:\\Games\\Control Ultimate Edition",
      addedOn: NOW - 86_400,
      completionOn: 0,
      numSeeds: 3,
      numLeechs: 8,
      category: "games",
      tags: [],
      files: [
        {
          index: 0,
          name: "Control Ultimate Edition/Control_DX12.exe",
          size: 80_000_000,
          progress: 1,
          priority: 1,
        },
        {
          index: 1,
          name: "Control Ultimate Edition/data/pack0.pack",
          size: 8_000_000_000,
          progress: 0.22,
          priority: 1,
        },
        {
          index: 2,
          name: "Control Ultimate Edition/data/pack1.pack",
          size: 6_000_000_000,
          progress: 0,
          priority: 1,
        },
        {
          index: 3,
          name: "Control Ultimate Edition/readme.txt",
          size: 2_400,
          progress: 1,
          priority: 1,
        },
      ],
    },
    {
      hash: DEMO_HASH.blender,
      name: "Blender 4.5.3 Windows x64",
      rawState: "uploading",
      progress: 1,
      size: 340_000_000,
      totalSize: 340_000_000,
      downloaded: 340_000_000,
      uploaded: 272_000_000,
      dlspeed: 0,
      upspeed: 450_000,
      eta: INFINITY_ETA,
      ratio: 0.8,
      savePath: "D:\\Downloads",
      contentPath: "D:\\Downloads\\blender-4.5.3-windows-x64.msi",
      addedOn: NOW - 6 * 86_400,
      completionOn: NOW - 6 * 86_400 + 1800,
      numSeeds: 40,
      numLeechs: 5,
      category: "apps",
      tags: [],
      files: [
        {
          index: 0,
          name: "blender-4.5.3-windows-x64.msi",
          size: 340_000_000,
          progress: 1,
          priority: 1,
        },
      ],
    },
    {
      hash: DEMO_HASH.archive,
      name: "Семейный архив 2019",
      rawState: "missingFiles",
      progress: 1,
      size: 18_000_000_000,
      totalSize: 18_000_000_000,
      downloaded: 18_000_000_000,
      uploaded: 0,
      dlspeed: 0,
      upspeed: 0,
      eta: INFINITY_ETA,
      ratio: 0,
      savePath: "E:\\Archive",
      contentPath: "E:\\Archive\\Семейный архив 2019",
      addedOn: NOW - 200 * 86_400,
      completionOn: NOW - 199 * 86_400,
      numSeeds: 0,
      numLeechs: 0,
      category: "personal",
      tags: [],
      files: [
        {
          index: 0,
          name: "Семейный архив 2019/2019-07/IMG_2041.jpg",
          size: 4_000_000,
          progress: 1,
          priority: 1,
        },
        {
          index: 1,
          name: "Семейный архив 2019/видео/день рождения.mp4",
          size: 8_000_000_000,
          progress: 1,
          priority: 1,
        },
      ],
    },
    {
      hash: DEMO_HASH.cyberpunk,
      name: "Cyberpunk 2077",
      rawState: "pausedDL",
      progress: 0.15,
      size: 3_000_000_000,
      totalSize: 20_090_000_000,
      downloaded: 3_000_000_000,
      uploaded: 0,
      dlspeed: 0,
      upspeed: 0,
      eta: INFINITY_ETA,
      ratio: 0,
      savePath: "D:\\Games",
      contentPath: "D:\\Games\\Cyberpunk 2077",
      addedOn: NOW - 3 * 86_400,
      completionOn: 0,
      numSeeds: 12,
      numLeechs: 4,
      category: "games",
      tags: [],
      files: [
        {
          index: 0,
          name: "Cyberpunk 2077/bin/x64/Cyberpunk2077.exe",
          size: 90_000_000,
          progress: 1,
          priority: 1,
        },
        {
          index: 1,
          name: "Cyberpunk 2077/archive/pc/content.archive",
          size: 20_000_000_000,
          progress: 0.15,
          priority: 1,
        },
      ],
    },
    {
      hash: DEMO_HASH.vacation,
      name: "Отпуск 2024",
      rawState: "downloading",
      progress: 0.05,
      size: 600_000_000,
      totalSize: 12_000_000_000,
      downloaded: 600_000_000,
      uploaded: 0,
      dlspeed: 2_000_000,
      upspeed: 0,
      eta: 20_000,
      ratio: 0,
      savePath: "E:\\Archive",
      contentPath: "E:\\Archive\\Отпуск 2024",
      addedOn: NOW - 7_200,
      completionOn: 0,
      numSeeds: 1,
      numLeechs: 0,
      category: "personal",
      tags: [],
      files: [
        {
          index: 0,
          name: "Отпуск 2024/видео/море.mp4",
          size: 12_000_000_000,
          progress: 0.05,
          priority: 1,
        },
      ],
    },
  ];
}
