import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { appDataDir } from "@/lib/app-data";
import { AppError } from "@/lib/app-error";
import { getDisk } from "@/lib/drive/catalog";
import { joinCatalogPath, resolveFilesystem, sanitizeRelative, type OsKind } from "@/lib/drive/filesystem";
import type { ReceiveDestination } from "@/lib/localsend/server";

export interface LocalSendSettings {
  alias: string;
  receivePin: string;
  destination:
    | { mode: "disk"; diskId: string; folder: string }
    | { mode: "path"; os: OsKind; path: string };
}

export function defaultSettings(): LocalSendSettings {
  return {
    alias: "Склад",
    receivePin: "",
    destination: {
      mode: "path",
      os: "linux",
      path: path.join(appDataDir(), "localsend-inbox"),
    },
  };
}

export async function loadSettings(): Promise<LocalSendSettings> {
  try {
    const text = await readFile(settingsPath(), "utf8");
    return normalizeSettings(JSON.parse(text) as Partial<LocalSendSettings>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings();
    throw new AppError(500, "Не удалось прочитать настройки LocalSend.");
  }
}

export async function saveSettings(input: Partial<LocalSendSettings>): Promise<LocalSendSettings> {
  const next = normalizeSettings({ ...defaultSettings(), ...input, destination: input.destination ?? defaultSettings().destination });
  const file = settingsPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, file);
  const destination = await resolveReceiveDestination(next);
  if (canCreate(destination.writeRoot)) {
    await mkdir(destination.writeRoot, { recursive: true });
  }
  return next;
}

export async function resolveReceiveDestination(settings = null as LocalSendSettings | null): Promise<ReceiveDestination> {
  const current = settings ?? (await loadSettings());
  if (current.destination.mode === "disk") {
    const disk = getDisk(current.destination.diskId);
    if (!disk) throw new AppError(400, "Диск назначения не найден в каталоге.");
    const folder = current.destination.folder.trim();
    const catalogRoot = folder ? joinCatalogPath(disk.os, disk.mount, folder) : disk.mount;
    const writeRoot = disk.localRoot ? localJoin(disk.localRoot, folder) : catalogRoot;
    return {
      writeRoot,
      catalogRoot,
      os: disk.os,
      filesystem: resolveFilesystem({ os: disk.os, path: catalogRoot, filesystem: disk.filesystem }),
      diskId: disk.id,
      hostId: disk.hostId,
    };
  }
  const destinationPath = current.destination.path.trim();
  return {
    writeRoot: destinationPath,
    catalogRoot: destinationPath,
    os: current.destination.os,
    filesystem: resolveFilesystem({ os: current.destination.os, path: destinationPath, filesystem: null }),
    diskId: null,
    hostId: "local",
  };
}

function normalizeSettings(input: Partial<LocalSendSettings>): LocalSendSettings {
  const alias = String(input.alias || "").trim();
  if (!alias) throw new AppError(400, "Укажите имя этого устройства в сети.");
  if (alias.length > 80) throw new AppError(400, "Имя устройства длиннее 80 символов.");
  const receivePin = String(input.receivePin || "").trim();
  if (receivePin && !/^\d{1,12}$/.test(receivePin)) {
    throw new AppError(400, "PIN приёма — до 12 цифр или пусто.");
  }
  const destination = input.destination;
  if (!destination || (destination.mode !== "disk" && destination.mode !== "path")) {
    throw new AppError(400, "Укажите, куда складывать входящие.");
  }
  if (destination.mode === "disk") {
    if (!getDisk(String(destination.diskId || ""))) throw new AppError(400, "Выберите диск из каталога.");
    const folder = String(destination.folder || "").trim();
    if (folder) sanitizeRelative(folder);
    return { alias, receivePin, destination: { mode: "disk", diskId: destination.diskId, folder } };
  }
  const os = destination.os;
  if (os !== "darwin" && os !== "win32" && os !== "linux") {
    throw new AppError(400, "Выберите систему пути: macOS, Windows или Linux.");
  }
  const destinationPath = String(destination.path || "").trim();
  if (os === "win32" && !/^[A-Za-z]:[\\/]/.test(destinationPath)) {
    throw new AppError(400, "На Windows путь выглядит как D:\\Incoming.");
  }
  if (os !== "win32" && !destinationPath.startsWith("/")) {
    throw new AppError(400, "На macOS и Linux путь начинается с /.");
  }
  return { alias, receivePin, destination: { mode: "path", os, path: destinationPath } };
}

function localJoin(root: string, folder: string): string {
  if (!folder.trim()) return root;
  const relative = sanitizeRelative(folder);
  return path.resolve(root, ...relative.split("/"));
}

function canCreate(target: string): boolean {
  if (process.platform === "win32") return true;
  return target.startsWith("/");
}

function settingsPath(): string {
  return path.join(appDataDir(), "localsend.json");
}
