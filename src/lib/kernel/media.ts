import { randomUUID } from "node:crypto";

import type { HostOs } from "@/lib/qbittorrent/types";

import { listDisks } from "@/lib/kernel/catalog";
import { demoSettings } from "@/lib/kernel/demo-seed";
import { SkladError } from "@/lib/kernel/errors";
import { readJsonFile, writeJsonFile } from "@/lib/kernel/json-file";
import { enqueueJob, type NewJobInput } from "@/lib/kernel/jobs";
import { withLock } from "@/lib/kernel/lock";
import type { CompactAlgorithm, Filesystem, JobRecord, LibraryEntry, ToolSettings } from "@/lib/kernel/types";
import { COMPACT_ALGORITHMS } from "@/lib/kernel/types";
import { isVaultPath, resolveSlot } from "@/lib/kernel/volume";

const SETTINGS = "settings.json";
const LIBRARY = "library.json";

interface LibraryFile {
  entries: LibraryEntry[];
}

export function assertCanCompact(os: HostOs, filesystem: Filesystem | null, targetPath: string): void {
  if (os !== "win32") {
    throw new SkladError("unavailable", "На Mac CompactGUI недоступен. Сжатие NTFS есть только на Windows.");
  }
  if (isVaultPath(targetPath)) {
    throw new SkladError("validation", "Нельзя сжимать /Volumes/vault.");
  }
  if (filesystem !== "ntfs") {
    throw new SkladError("validation", "CompactGUI и compact.exe работают только с NTFS.");
  }
}

export async function loadSettings(): Promise<ToolSettings> {
  return withLock("settings", async () => (await readJsonFile<ToolSettings>(SETTINGS)) ?? demoSettings());
}

export async function ensureDemoSettings(): Promise<ToolSettings> {
  return withLock("settings", async () => {
    const existing = await readJsonFile<ToolSettings>(SETTINGS);
    if (existing) return existing;
    const settings = demoSettings();
    await writeJsonFile(SETTINGS, settings);
    return settings;
  });
}

export async function saveSettings(settings: ToolSettings): Promise<ToolSettings> {
  const next: ToolSettings = {
    handbrakePath: {
      darwin: settings.handbrakePath.darwin.trim(),
      win32: settings.handbrakePath.win32.trim(),
    },
    compactExePath: settings.compactExePath.trim(),
  };
  await withLock("settings", async () => {
    await writeJsonFile(SETTINGS, next);
  });
  return next;
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  return withLock("library", async () => (await readJsonFile<LibraryFile>(LIBRARY))?.entries ?? []);
}

export async function upsertLibrary(entry: Omit<LibraryEntry, "id"> & { id?: string }): Promise<LibraryEntry> {
  return withLock("library", async () => {
    const entries = (await readJsonFile<LibraryFile>(LIBRARY))?.entries ?? [];
    const existing = entries.find((item) => item.jobId === entry.jobId || (entry.id && item.id === entry.id));
    const saved: LibraryEntry = {
      id: existing?.id ?? entry.id ?? `lib-${randomUUID()}`,
      name: entry.name,
      source: entry.source,
      destination: entry.destination,
      hostId: entry.hostId,
      diskId: entry.diskId,
      verified: entry.verified,
      sourceDeleted: false,
      removalConfirmed: existing?.removalConfirmed || entry.removalConfirmed,
      jobId: entry.jobId,
    };
    const next = existing ? entries.map((item) => (item.id === saved.id ? saved : item)) : [...entries, saved];
    await writeJsonFile(LIBRARY, { entries: next });
    return saved;
  });
}

export async function confirmRemoval(entryId: string): Promise<{ job: JobRecord; created: boolean }> {
  const entries = await listLibrary();
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) throw new SkladError("not_found", "Записи в библиотеке нет.");
  if (!entry.verified) {
    throw new SkladError("validation", "Копия ещё не проверена. Исходник не удалён.");
  }
  const queued = await enqueueJob({
    kind: "delete-source",
    hostId: entry.hostId,
    title: `Подтверждение удаления: ${entry.name}`,
    source: entry.source,
    destination: entry.destination,
    totalBytes: 1,
    currentFile: entry.source,
    message: "В очереди. Это отдельное подтверждение, не часть копирования.",
    payload: { entryId: entry.id, confirmed: true, sourceDeleted: false },
  });
  return queued;
}

export async function markRemovalConfirmed(entryId: string): Promise<void> {
  await withLock("library", async () => {
    const entries = (await readJsonFile<LibraryFile>(LIBRARY))?.entries ?? [];
    const entry = entries.find((item) => item.id === entryId);
    if (!entry || !entry.verified) return;
    entry.removalConfirmed = true;
    entry.sourceDeleted = false;
    await writeJsonFile(LIBRARY, { entries });
  });
}

async function filesystemFor(hostId: string, os: HostOs, targetPath: string): Promise<Filesystem | null> {
  const disks = await listDisks();
  return resolveSlot(disks, hostId, os, targetPath).filesystem;
}

export async function enqueueMove(input: {
  hostId: string;
  os: HostOs;
  name: string;
  source: string;
  destination: string;
  compact: boolean;
  algorithm?: CompactAlgorithm;
}): Promise<{ job: JobRecord; created: boolean }> {
  if (input.compact) {
    const filesystem = await filesystemFor(input.hostId, input.os, input.destination);
    assertCanCompact(input.os, filesystem, input.destination);
  }
  const algorithm = input.algorithm && COMPACT_ALGORITHMS.includes(input.algorithm) ? input.algorithm : "XPRESS8K";
  return enqueueJob(jobInput({
    kind: "move",
    hostId: input.hostId,
    title: `Копия «${input.name}»`,
    source: input.source,
    destination: input.destination,
    totalBytes: 8_000_000_000,
    currentFile: input.source,
    message: "В очереди. Это копия: исходник не удаляется, пока вы отдельно не подтвердите.",
    payload: {
      verify: true,
      compactAfter: input.compact,
      algorithm,
      libraryName: input.name,
      sourceDeleted: false,
    },
  }));
}

export async function enqueueCompact(input: {
  hostId: string;
  os: HostOs;
  source: string;
  algorithm: CompactAlgorithm;
}): Promise<{ job: JobRecord; created: boolean }> {
  if (!COMPACT_ALGORITHMS.includes(input.algorithm)) {
    throw new SkladError("validation", "Алгоритм: LZX, XPRESS8K, XPRESS16K или XPRESS4K.");
  }
  const filesystem = await filesystemFor(input.hostId, input.os, input.source);
  assertCanCompact(input.os, filesystem, input.source);
  const settings = await loadSettings();
  return enqueueJob(jobInput({
    kind: "compact",
    hostId: input.hostId,
    title: `Сжатие NTFS ${input.algorithm}`,
    source: input.source,
    destination: input.source,
    totalBytes: 4_000_000_000,
    currentFile: input.source,
    message: settings.compactExePath
      ? "В очереди. compact.exe вызовет агент Windows, файлы не удаляются."
      : "В очереди. Путь к compact.exe не задан: в демо исполнитель подставной и ничего не сожмет на диске.",
    payload: { algorithm: input.algorithm, estimate: false, sourceDeleted: false },
  }));
}

export async function enqueueTranscode(input: {
  hostId: string;
  os: HostOs;
  source: string;
  destination: string;
  codec: string;
  quality: number;
}): Promise<{ job: JobRecord; created: boolean }> {
  if (!input.destination.trim()) throw new SkladError("validation", "Нужен путь готового файла. Исходник не перезаписывается.");
  if (normalize(input.source) === normalize(input.destination)) {
    throw new SkladError("validation", "Выход HandBrake должен быть отдельным файлом.");
  }
  const settings = await loadSettings();
  const configured = settings.handbrakePath[input.os].length > 0;
  return enqueueJob(jobInput({
    kind: "transcode",
    hostId: input.hostId,
    title: "HandBrake",
    source: input.source,
    destination: input.destination,
    totalBytes: 10_000_000_000,
    currentFile: input.source,
    message: configured
      ? "В очереди. Агент вызовет HandBrakeCLI по заданному пути. Исходник не удаляется."
      : "В очереди. Путь HandBrakeCLI пуст: демо-исполнитель не запускает кодирование и не трогает исходник.",
    payload: {
      codec: input.codec || "x264",
      quality: input.quality,
      mock: !configured,
      sourceDeleted: false,
    },
  }));
}

function jobInput(input: NewJobInput): NewJobInput {
  return input;
}

function normalize(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}
