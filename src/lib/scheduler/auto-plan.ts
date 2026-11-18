import { classify } from "@/lib/content/classify";
import type { ContentKind, GameSubtype, IndexProfile, PostAction } from "@/lib/content/types";
import type { ClassifyReason } from "@/lib/content/types";
import type { CatalogDisk } from "@/lib/drives/types";
import { constrainToFilesystem, resolveDestination, safeLeaf, sameDirectory } from "@/lib/policies/resolve";
import type { HandbrakeSettings, PolicyHost, PolicyRules } from "@/lib/policies/types";
import { joinRemotePath, normalizeRemotePath } from "@/lib/qbittorrent/paths";
import type { HostOs } from "@/lib/qbittorrent/types";

import { isSkippedVolume, skippedVolumeNote } from "@/lib/scheduler/skipped-volume";

export const PIPELINE_STAGES = ["index", "classify", "layout", "transfer", "compress", "verify"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const INCOMING_FOLDER = /^(downloads?|загрузки|incoming|incomplete|qbittorrent|temp|tmp)$/i;

export interface PlacementInput {
  name: string;
  sourcePath: string;
  os: HostOs;
  files?: { name: string; size: number }[];
  rules: PolicyRules;
  disks: CatalogDisk[];
  hosts: PolicyHost[];
  hostId: string;
}

export interface PlacementPlan {
  skippedVolume: boolean;
  kind: ContentKind;
  gameSubtype: GameSubtype | null;
  reason: ClassifyReason;
  detail: string;
  folder: string;
  destinationDir: string;
  copyRoot: string;
  postAction: PostAction;
  indexProfile: IndexProfile;
  note: string;
  transfer: "skip" | "copy" | "wait";
  deletesSource: false;
  handbrake: HandbrakeSettings;
  sameHost: boolean;
  destDiskId: string | null;
  destOnline: boolean;
}

export function planPlacement(input: PlacementInput): PlacementPlan {
  const emptyHandbrake = input.rules.movie.handbrake;
  if (isSkippedVolume(input.sourcePath)) {
    return blank(emptyHandbrake, {
      skippedVolume: true,
      note: skippedVolumeNote(input.sourcePath),
      transfer: "skip",
    });
  }

  const classification = classify({
    name: input.name,
    savePath: input.sourcePath,
    files: input.files,
  });
  const rule = input.rules[classification.kind];
  const dest = resolveDestination(rule, input.disks, input.hosts);
  const limits = constrainToFilesystem(rule, dest.filesystem);
  if (isSkippedVolume(dest.path) || isSkippedVolume(dest.folder)) {
    return blank(rule.handbrake, {
      kind: classification.kind,
      gameSubtype: classification.gameSubtype,
      reason: classification.reason,
      detail: classification.detail,
      note: "Назначение на диске Z: не используется. Файлы остаются на месте.",
      transfer: "skip",
    });
  }

  const destinationDir = dest.path;
  const copyRoot = destinationDir ? joinRemotePath(input.os, destinationDir, safeLeaf(input.name)) : "";
  const sameHost = Boolean(dest.hostId) && dest.hostId === input.hostId;
  const base = {
    kind: classification.kind,
    gameSubtype: classification.gameSubtype,
    reason: classification.reason,
    detail: classification.detail,
    folder: dest.folder || rule.folder,
    destinationDir,
    copyRoot,
    postAction: limits.postAction,
    indexProfile: limits.indexProfile,
    handbrake: rule.handbrake,
    sameHost,
    destDiskId: dest.diskId,
    destOnline: dest.online,
    deletesSource: false as const,
    skippedVolume: false,
  };

  if (!destinationDir || dest.missing) {
    return { ...base, transfer: "skip", note: "Папка библиотеки не выбрана. Файл остаётся на месте." };
  }
  if (!dest.online) {
    return { ...base, transfer: "wait", note: "Диск назначения не подключён. Оригинал остаётся на месте." };
  }
  if (alreadyInside(input.os, input.sourcePath, destinationDir)) {
    return { ...base, transfer: "skip", copyRoot: input.sourcePath, note: "Уже лежит в папке библиотеки. Копия не нужна." };
  }
  if (!sameHost) {
    return {
      ...base,
      transfer: "wait",
      note: "Библиотека на другом компьютере. Копия пойдёт туда, где подключён диск. Исходник не удаляется.",
    };
  }
  const post = limits.postNote ? ` ${limits.postNote}` : "";
  return { ...base, transfer: "copy", note: `Копия в «${base.folder}». Исходник остаётся.${post}` };
}

export function folderKind(mount: string, folderName: string, os: HostOs): ContentKind {
  const savePath = joinRemotePath(os, mount, folderName);
  return classify({ name: folderName, savePath }).kind;
}

function alreadyInside(os: HostOs, source: string, destinationDir: string): boolean {
  if (!source || !destinationDir) return false;
  if (sameDirectory(os, source, destinationDir)) return true;
  const src = normalizeRemotePath(os, source).toLowerCase();
  const dest = normalizeRemotePath(os, destinationDir).toLowerCase();
  const sep = os === "win32" ? "\\" : "/";
  return src.startsWith(`${dest}${sep}`);
}

function blank(handbrake: HandbrakeSettings, patch: Partial<PlacementPlan> & Pick<PlacementPlan, "note" | "transfer">): PlacementPlan {
  return {
    skippedVolume: false,
    kind: "other",
    gameSubtype: null,
    reason: "unknown",
    detail: "",
    folder: "",
    destinationDir: "",
    copyRoot: "",
    postAction: "none",
    indexProfile: "none",
    handbrake,
    sameHost: true,
    destDiskId: null,
    destOnline: false,
    deletesSource: false,
    ...patch,
  };
}
