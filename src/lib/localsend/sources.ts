import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import { joinDisplay } from "@/addons/drives/paths";
import { online } from "@/addons/drives/reconcile";
import { readAgentConfig, readCatalog } from "@/addons/drives/store";
import type { AgentEndpoint, DiskRecord, IndexedFile } from "@/addons/drives/types";
import { AppError } from "@/lib/app-error";
import { entriesByIds, expandSelection } from "@/lib/drive/catalog";
import { isPathUnder } from "@/lib/drive/filesystem";
import {
  displayInside,
  insideFolder,
  isProtectedVolume,
  machineLabel,
  protocolFileName,
  relativeFromRoot,
  safeRelative,
  stripMount,
} from "@/lib/localsend/paths";
import { fileTypeForName } from "@/lib/localsend/protocol";
import { statAgentFile, type RemoteSource } from "@/lib/localsend/remote";

export type { RemoteSource };

export interface SendFilePayload {
  fileId: string;
  fileName: string;
  size: number;
  fileType: string;
  localPath: string | null;
  remote: RemoteSource | null;
  catalogPath: string;
  diskId: string;
  hostId: string;
  hostLabel: string;
  sha256: string | null;
  sent: boolean;
}

export interface DrivePick {
  diskId: string;
  path: string;
  name: string;
  kind?: string;
}

const PROTECTED = "Диск Z: не используется. Файл не читался и не отправлялся.";

export async function collectSendFiles(entryIds: string[], picks: DrivePick[]): Promise<SendFilePayload[]> {
  const fromCatalog = await catalogFiles(entryIds);
  const fromShelf = await shelfFiles(picks);
  if (fromCatalog.length + fromShelf.length === 0) {
    throw new AppError(400, "Выберите файл или папку.");
  }
  return [...fromCatalog, ...fromShelf];
}

async function catalogFiles(ids: string[]): Promise<SendFilePayload[]> {
  if (ids.length === 0) return [];
  const picked = await entriesByIds(ids);
  for (const entry of picked) {
    if (isProtectedVolume(entry.path) || (entry.localPath != null && isProtectedVolume(entry.localPath))) {
      throw new AppError(400, PROTECTED);
    }
  }
  const expanded = await expandSelection(ids);
  const files: SendFilePayload[] = [];
  for (const entry of expanded) {
    if (entry.kind !== "file") continue;
    if (isProtectedVolume(entry.path) || (entry.localPath != null && isProtectedVolume(entry.localPath))) {
      throw new AppError(400, PROTECTED);
    }
    const folder = picked.find((item) => item.kind === "folder" && isPathUnder(item.os, item.path, entry.path));
    const fileName = folder
      ? protocolFileName(folder.name, relativeFromRoot(folder.path, entry.path, folder.os), entry.name)
      : protocolFileName(null, entry.name, entry.name);
    const hostLabel = machineLabel({ os: entry.os, hostId: entry.hostId, path: entry.path });
    if (!entry.localPath) {
      throw new AppError(
        400,
        `«${entry.name}» на ${hostLabel} недоступен: нет локальной копии и агент диска не указан. Отправка не создана.`,
      );
    }
    const info = await stat(entry.localPath);
    if (!info.isFile()) throw new AppError(400, `«${entry.name}» не файл.`);
    files.push(
      makePayload({
        fileName,
        size: info.size,
        localPath: entry.localPath,
        remote: null,
        catalogPath: entry.path,
        diskId: entry.diskId,
        hostId: entry.hostId,
        hostLabel,
      }),
    );
  }
  return files;
}

async function shelfFiles(picks: DrivePick[]): Promise<SendFilePayload[]> {
  if (picks.length === 0) return [];
  const catalog = await readCatalog();
  const disks = catalog?.disks ?? [];
  const config = await readAgentConfig();
  const files: SendFilePayload[] = [];
  for (const pick of picks) {
    const disk = disks.find((item) => item.id === pick.diskId);
    if (!disk) throw new AppError(404, "Диск из полки не найден.");
    const mounts = [disk.lastMountPath, ...disk.connectedHosts.flatMap((host) => host.mountPaths)].filter(Boolean);
    if (mounts.some((mount) => isProtectedVolume(mount)) || isProtectedVolume(pick.path)) {
      throw new AppError(400, PROTECTED);
    }
    const mount = mounts[0] || "";
    const chosen = filesInside(disk, pick, mount);
    if (chosen.length === 0) {
      throw new AppError(400, `В каталоге нет файлов для «${pick.name || "выбора"}».`);
    }
    const host = disk.connectedHosts[0];
    const hostLabel = machineLabel({
      os: host?.os,
      hostId: disk.lastHostId,
      hostName: disk.lastHostName,
      path: mount || pick.path,
    });
    for (const file of chosen) {
      const relative = file.relativePath.replace(/\\/g, "/");
      const full = joinDisplay(disk.pathStyle, mount, file.relativePath);
      if (isProtectedVolume(full) || isProtectedVolume(relative)) throw new AppError(400, PROTECTED);
      const fileName =
        pick.kind === "dir"
          ? protocolFileName(pick.name, insideFolder(stripMount(mount, pick.path), relative), file.name)
          : protocolFileName(null, file.name, file.name);
      const local = await localFile(full);
      if (local) {
        files.push(
          makePayload({
            fileName,
            size: local.size,
            localPath: full,
            remote: null,
            catalogPath: full,
            diskId: disk.id,
            hostId: disk.lastHostId,
            hostLabel,
          }),
        );
        continue;
      }
      if (!online(disk)) {
        throw new AppError(409, `Диск «${disk.label}» на ${hostLabel} не подключён. Отправка не создана.`);
      }
      const agent = agentFor(config.agents, disk);
      if (!agent) throw new AppError(400, `Нет агента для ${hostLabel}. Файл не отправлен.`);
      const relativePath = safeRelative(file.relativePath);
      if (!relativePath) throw new AppError(400, "Некорректный путь внутри диска. Отправка не создана.");
      const remote: RemoteSource = {
        agentUrl: agent.url,
        serial: disk.serial,
        volumeUuid: disk.volumeUuid,
        relativePath,
      };
      const size = await statAgentFile(remote);
      files.push(
        makePayload({
          fileName,
          size,
          localPath: null,
          remote,
          catalogPath: full,
          diskId: disk.id,
          hostId: disk.lastHostId,
          hostLabel,
        }),
      );
    }
  }
  return files;
}

function filesInside(disk: DiskRecord, pick: DrivePick, mount: string): IndexedFile[] {
  return disk.files.filter((file) => {
    if (file.kind !== "file") return false;
    const full = joinDisplay(disk.pathStyle, mount, file.relativePath);
    if (pick.kind === "dir") return displayInside(pick.path, full) || full === pick.path;
    return full === pick.path || file.relativePath === pick.path || (file.name === pick.name && full.endsWith(pick.name));
  });
}

function agentFor(agents: AgentEndpoint[], disk: DiskRecord): AgentEndpoint | null {
  return (
    agents.find((item) => item.id === disk.lastHostId) ??
    agents.find((item) => item.os === (disk.pathStyle === "win32" ? "win32" : "darwin")) ??
    null
  );
}

async function localFile(full: string): Promise<{ size: number } | null> {
  if (!full || isProtectedVolume(full)) return null;
  try {
    const info = await stat(full);
    return info.isFile() ? { size: info.size } : null;
  } catch {
    return null;
  }
}

function makePayload(input: Omit<SendFilePayload, "fileId" | "fileType" | "sha256" | "sent">): SendFilePayload {
  return {
    ...input,
    fileId: randomUUID(),
    fileType: fileTypeForName(input.fileName),
    sha256: null,
    sent: false,
  };
}
