import type { IndexProfile, PostAction } from "@/lib/content/types";
import type { CatalogDisk } from "@/lib/drives/types";
import type { VolumeFilesystem } from "@/lib/policies/disks";
import { joinRemotePath, normalizeRemotePath } from "@/lib/qbittorrent/paths";
import type { HostOs } from "@/lib/qbittorrent/types";
import { diskKey, filesystemOf, pathOnDisk, primaryMount, toPolicyDisk } from "@/lib/policies/disks";
import type { HandbrakeSettings, PolicyHost, TypeRule } from "@/lib/policies/types";

export interface ResolvedDest {
  disk: CatalogDisk | null;
  diskId: string | null;
  label: string;
  online: boolean;
  filesystem: VolumeFilesystem | null;
  hostId: string;
  hostName: string;
  os: HostOs;
  folder: string;
  path: string;
  missing: boolean;
}

export interface FilesystemLimits {
  indexProfile: IndexProfile;
  indexNote: string | null;
  postAction: PostAction;
  postUnavailable: boolean;
  postNote: string | null;
}

export function resolveDestination(rule: TypeRule, disks: CatalogDisk[], hosts: PolicyHost[]): ResolvedDest {
  const folder = rule.folder.trim();
  if (rule.diskId) {
    const disk = disks.find((item) => item.id === rule.diskId || diskKey(item) === rule.diskId) ?? null;
    if (!disk) {
      return {
        disk: null,
        diskId: rule.diskId,
        label: "Диск не найден",
        online: false,
        filesystem: null,
        hostId: "",
        hostName: "",
        os: "darwin",
        folder,
        path: "",
        missing: true,
      };
    }
    const view = toPolicyDisk(disk, hosts.find((host) => host.id === primaryMount(disk)?.hostId)?.name ?? "");
    return {
      disk,
      diskId: view.id,
      label: view.label,
      online: disk.online,
      filesystem: view.filesystem,
      hostId: view.hostId,
      hostName: view.hostName,
      os: view.os,
      folder,
      path: view.mountPath ? joinRemotePath(view.os, view.mountPath, folder) : "",
      missing: !view.mountPath,
    };
  }

  const host = hosts.find((item) => item.id === rule.customHostId) ?? null;
  const os = host?.os ?? "darwin";
  const root = rule.customPath.trim();
  return {
    disk: null,
    diskId: null,
    label: host ? `Свой путь · ${host.name}` : "Свой путь",
    online: Boolean(host?.online && root),
    filesystem: null,
    hostId: host?.id ?? "",
    hostName: host?.name ?? "",
    os,
    folder,
    path: root ? joinRemotePath(os, root, folder) : "",
    missing: !root || !host,
  };
}

export function constrainToFilesystem(rule: TypeRule, filesystem: VolumeFilesystem | null): FilesystemLimits {
  let indexProfile = rule.indexProfile;
  let indexNote: string | null = null;
  if (rule.indexProfile === "ntfs-mft" && filesystem !== "ntfs") {
    indexProfile = "walk";
    indexNote =
      filesystem === "apfs"
        ? "NTFS MFT на APFS не запускается. Будет обычный обход."
        : "MFT только на NTFS. Будет обычный обход.";
  }

  if (rule.postAction === "compact" && filesystem !== "ntfs") {
    const where = filesystem === "apfs" ? "APFS" : "этом диске";
    return {
      indexProfile,
      indexNote,
      postAction: "none",
      postUnavailable: true,
      postNote: `CompactGUI только для NTFS. На ${where} сжатие недоступно и в прогон не входит.`,
    };
  }

  return {
    indexProfile,
    indexNote,
    postAction: rule.postAction,
    postUnavailable: false,
    postNote: null,
  };
}

export function alreadyOnDisk(savePath: string, disk: CatalogDisk | null): boolean {
  if (!disk) return false;
  return pathOnDisk(savePath, disk);
}

export function sameDirectory(os: HostOs, left: string, right: string): boolean {
  if (!left || !right) return false;
  return normalizeRemotePath(os, left).toLowerCase() === normalizeRemotePath(os, right).toLowerCase();
}

export function outputPath(os: HostOs, destination: string, leaf: string): string {
  return joinRemotePath(os, destination, leaf);
}

export function handbrakeLeaf(name: string, settings: HandbrakeSettings): string {
  return `encoded/${safeLeaf(name)}.${settings.container}`;
}

export function compactLeaf(name: string): string {
  return `compact/${safeLeaf(name)}`;
}

export function safeLeaf(name: string): string {
  const cleaned = name.replace(/[<>:"|?*]/g, " ").replace(/[. ]+$/g, "").trim();
  return cleaned.slice(0, 120) || "release";
}

export { filesystemOf };
