import { makeIdempotencyKey } from "@/lib/kernel/jobs";
import type { DiskRecord, JobRecord, PolicyFile, ToolSettings } from "@/lib/kernel/types";
import { emptyPrefs } from "@/lib/kernel/scheduler";
import type { SchedulerPrefs } from "@/lib/kernel/types";

export const DISK_VAULT = "disk-vault";
export const DISK_GAMES = "disk-games";
export const DISK_SSD = "disk-ssd";
export const DISK_ARCHIVE = "disk-archive";

const SEEN = 1_762_300_000_000;

export function demoDisks(): DiskRecord[] {
  return [
    {
      id: DISK_VAULT,
      serial: "SN-VAULT-1001",
      volumeUuid: "uuid-vault-1001",
      filesystem: "exfat",
      label: "Vault",
      totalBytes: 8_000_000_000_000,
      freeBytes: 3_200_000_000_000,
      online: true,
      mounts: [{ hostId: "demo-mac", mountPoint: "/Volumes/vault" }],
      lastMount: { hostId: "demo-mac", mountPoint: "/Volumes/vault" },
      lastSeen: SEEN,
      lastHostId: "demo-mac",
      files: [
        { path: "Cinema/Interstellar.2014.2160p.mkv", size: 62_400_000_000 },
        { path: "PSP/Games/Downloads/God of War (PSP)/ISO/ULUS10479.iso", size: 1_400_000_000 },
        { path: "Music/NieR Automata OST/01 - Significance.flac", size: 42_000_000 },
      ],
      indexStatus: "complete",
      indexMethod: "walk",
      indexError: null,
      indexedAt: SEEN,
      heavyActivity: false,
      elevated: false,
      located: [
        { kind: "media", name: "Интерстеллар (2014) 2160p UHD", path: "Cinema/Interstellar.2014.2160p.mkv" },
        { kind: "game", name: "God of War (PSP)", path: "PSP/Games/Downloads/God of War (PSP)" },
        { kind: "media", name: "NieR:Automata OST", path: "Music/NieR Automata OST" },
      ],
    },
    {
      id: DISK_GAMES,
      serial: "SN-GAMES-2002",
      volumeUuid: "uuid-games-2002",
      filesystem: "ntfs",
      label: "Игры HDD",
      totalBytes: 4_000_000_000_000,
      freeBytes: 1_100_000_000_000,
      online: true,
      mounts: [{ hostId: "demo-pc", mountPoint: "D:\\" }],
      lastMount: { hostId: "demo-pc", mountPoint: "D:\\" },
      lastSeen: SEEN,
      lastHostId: "demo-pc",
      files: [
        { path: "Games/Control Ultimate Edition/Control_DX12.exe", size: 80_000_000 },
        { path: "Games/Control Ultimate Edition/data/pack0.pack", size: 8_000_000_000 },
        { path: "Downloads/blender-4.5.3-windows-x64.msi", size: 340_000_000 },
      ],
      indexStatus: "complete",
      indexMethod: "walk",
      indexError: null,
      indexedAt: SEEN,
      heavyActivity: false,
      elevated: false,
      located: [{ kind: "game", name: "Control Ultimate Edition", path: "Games/Control Ultimate Edition" }],
    },
    {
      id: DISK_SSD,
      serial: "SN-SSD-3003",
      volumeUuid: "uuid-ssd-3003",
      filesystem: "ntfs",
      label: "SSD игры",
      totalBytes: 1_000_000_000_000,
      freeBytes: 640_000_000_000,
      online: true,
      mounts: [{ hostId: "demo-pc", mountPoint: "F:\\" }],
      lastMount: { hostId: "demo-pc", mountPoint: "F:\\" },
      lastSeen: SEEN,
      lastHostId: "demo-pc",
      files: [],
      indexStatus: "idle",
      indexMethod: null,
      indexError: null,
      indexedAt: null,
      heavyActivity: false,
      elevated: false,
      located: [],
    },
    {
      id: DISK_ARCHIVE,
      serial: "SN-ARCHIVE-4004",
      volumeUuid: "uuid-archive-4004",
      filesystem: "ntfs",
      label: "Семейный архив",
      totalBytes: 2_000_000_000_000,
      freeBytes: 400_000_000_000,
      online: false,
      mounts: [],
      lastMount: { hostId: "demo-pc", mountPoint: "E:\\" },
      lastSeen: SEEN - 86_400_000,
      lastHostId: "demo-pc",
      files: [
        { path: "Archive/Семейный архив 2019/2019-07/IMG_2041.jpg", size: 4_000_000 },
        { path: "Archive/Семейный архив 2019/видео/день рождения.mp4", size: 8_000_000_000 },
      ],
      indexStatus: "complete",
      indexMethod: "walk",
      indexError: null,
      indexedAt: SEEN - 86_400_000,
      heavyActivity: false,
      elevated: false,
      located: [{ kind: "media", name: "Семейный архив 2019", path: "Archive/Семейный архив 2019" }],
    },
  ];
}

export function demoPolicy(): PolicyFile {
  const game = {
    diskId: DISK_GAMES,
    indexProfile: "full" as const,
    postProcess: "none" as const,
    handbrake: null,
    compactAfterMove: true,
  };
  return {
    automationEnabled: false,
    lastDryRunAt: null,
    dryRunFingerprint: null,
    customRules: [],
    profiles: [
      { contentKind: "game-pc", folder: "Games", ...game },
      { contentKind: "game-console", folder: "Console", ...game },
      {
        contentKind: "game-psp",
        diskId: DISK_VAULT,
        folder: "PSP/Games",
        indexProfile: "full",
        postProcess: "none",
        handbrake: null,
        compactAfterMove: false,
      },
      { contentKind: "game-other", folder: "Games", ...game },
      {
        contentKind: "movie",
        diskId: DISK_VAULT,
        folder: "Cinema",
        indexProfile: "full",
        postProcess: "handbrake",
        handbrake: { codec: "x264", quality: 20 },
        compactAfterMove: false,
      },
      {
        contentKind: "series",
        diskId: DISK_VAULT,
        folder: "Series",
        indexProfile: "full",
        postProcess: "handbrake",
        handbrake: { codec: "x264", quality: 22 },
        compactAfterMove: false,
      },
      {
        contentKind: "music",
        diskId: DISK_VAULT,
        folder: "Music",
        indexProfile: "full",
        postProcess: "none",
        handbrake: null,
        compactAfterMove: false,
      },
      {
        contentKind: "software",
        diskId: null,
        folder: "",
        indexProfile: "full",
        postProcess: "none",
        handbrake: null,
        compactAfterMove: false,
      },
      {
        contentKind: "document",
        diskId: null,
        folder: "",
        indexProfile: "names-only",
        postProcess: "none",
        handbrake: null,
        compactAfterMove: false,
      },
      {
        contentKind: "other",
        diskId: null,
        folder: "",
        indexProfile: "names-only",
        postProcess: "none",
        handbrake: null,
        compactAfterMove: false,
      },
    ],
  };
}

export function demoSettings(): ToolSettings {
  return {
    handbrakePath: { darwin: "", win32: "" },
    compactExePath: "",
  };
}

export function demoPrefs(): SchedulerPrefs {
  return emptyPrefs();
}

function seedJob(input: Omit<JobRecord, "idempotencyKey" | "version" | "pauseSupported" | "cancelSupported" | "pauseRefusal"> & {
  pauseSupported?: boolean;
  cancelSupported?: boolean;
  pauseRefusal?: string;
}): JobRecord {
  return {
    ...input,
    version: 1,
    pauseSupported: input.pauseSupported ?? true,
    cancelSupported: input.cancelSupported ?? true,
    pauseRefusal: input.pauseRefusal ?? "",
    idempotencyKey: makeIdempotencyKey(input),
  };
}

/** Two PC jobs so one stays queued while the other runs. Mac job runs in parallel. */
export function demoJobs(now = SEEN): JobRecord[] {
  return [
    seedJob({
      id: "job-demo-copy-control",
      kind: "move",
      hostId: "demo-pc",
      title: "Копия Control на SSD",
      source: "D:\\Games\\Control Ultimate Edition",
      destination: "F:\\Games\\Control Ultimate Edition",
      state: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: 3,
      claimToken: null,
      claimedBy: null,
      message: "В очереди. Исходник не удаляется, пока копия не проверена и вы сами не подтвердите.",
      progress: {
        currentFile: "Control_DX12.exe",
        processedBytes: 0,
        totalBytes: 14_000_000_000,
        speedBps: 0,
        etaSeconds: null,
        percent: 0,
      },
      payload: { sourceDeleted: false, verify: true, compactAfter: false, libraryName: "Control Ultimate Edition" },
    }),
    seedJob({
      id: "job-demo-index-games",
      kind: "index",
      hostId: "demo-pc",
      title: "Индексация «Игры HDD»",
      source: "disk:disk-games",
      destination: "disk:disk-games",
      state: "queued",
      createdAt: now + 1,
      updatedAt: now + 1,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: 3,
      claimToken: null,
      claimedBy: null,
      message: "В очереди. Индексация только читает каталог.",
      progress: {
        currentFile: "D:\\",
        processedBytes: 0,
        totalBytes: 3,
        speedBps: 0,
        etaSeconds: null,
        percent: 0,
      },
      payload: { sourceDeleted: false, readOnly: true, diskId: "disk-games" },
    }),
    seedJob({
      id: "job-demo-hb-interstellar",
      kind: "transcode",
      hostId: "demo-mac",
      title: "HandBrake: Интерстеллар в отдельный файл",
      source: "/Volumes/vault/Cinema/Interstellar.2014.2160p.mkv",
      destination: "/Volumes/vault/Cinema/Interstellar.2014.1080p.mp4",
      state: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: 3,
      claimToken: null,
      claimedBy: null,
      pauseSupported: false,
      pauseRefusal: "HandBrakeCLI из Склада нельзя поставить на паузу. Отмена не удаляет исходник.",
      message: "В очереди. Демо не вызывает HandBrakeCLI, исходный MKV остаётся.",
      progress: {
        currentFile: "Interstellar.2014.2160p.mkv",
        processedBytes: 0,
        totalBytes: 62_400_000_000,
        speedBps: 0,
        etaSeconds: null,
        percent: 0,
      },
      payload: { sourceDeleted: false, codec: "x264", quality: 20, mock: true },
    }),
  ];
}
