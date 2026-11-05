import type { HostOs } from "@/lib/qbittorrent/types";

import { demoPolicy } from "@/lib/kernel/demo-seed";
import { SkladError } from "@/lib/kernel/errors";
import { readJsonFile, writeJsonFile } from "@/lib/kernel/json-file";
import { classify } from "@/lib/kernel/classify";
import { withLock } from "@/lib/kernel/lock";
import type { ContentKind, DiskRecord, PolicyFile, PolicyProfile } from "@/lib/kernel/types";
import { KIND_LABEL } from "@/lib/kernel/labels";
import { joinRemotePath } from "@/lib/qbittorrent/paths";
import { getDashboard } from "@/lib/qbittorrent/service";

const FILE = "policies.json";

export interface DryTorrent {
  hostId: string;
  hash: string;
  name: string;
  savePath: string;
  contentPath: string;
  progress: number;
  size: number;
  os: HostOs;
}

export interface DryItem {
  hostId: string;
  hash: string;
  name: string;
  kind: ContentKind;
  kindLabel: string;
  reason: string;
  diskId: string | null;
  diskLabel: string;
  currentPath: string;
  destinationPath: string;
  postProcess: PolicyProfile["postProcess"];
  detail: string;
  deletes: false;
  relocatesViaSetLocation: boolean;
}

export interface DryRun {
  items: DryItem[];
  deletesAnything: false;
  fingerprint: string;
  generatedAt: number;
}

async function readPolicy(): Promise<PolicyFile | null> {
  return readJsonFile<PolicyFile>(FILE);
}

async function writePolicy(policy: PolicyFile): Promise<void> {
  await writeJsonFile(FILE, policy);
}

export async function loadPolicy(): Promise<PolicyFile> {
  return withLock("policy", async () => (await readPolicy()) ?? demoPolicy());
}

export async function ensureDemoPolicy(): Promise<PolicyFile> {
  return withLock("policy", async () => {
    const existing = await readPolicy();
    if (existing) return existing;
    const policy = demoPolicy();
    await writePolicy(policy);
    return policy;
  });
}

export async function savePolicy(policy: PolicyFile): Promise<PolicyFile> {
  const next: PolicyFile = {
    ...policy,
    automationEnabled: false,
    dryRunFingerprint: null,
    lastDryRunAt: null,
  };
  await withLock("policy", async () => {
    await writePolicy(next);
  });
  return next;
}

export function computeFingerprint(torrents: DryTorrent[], policy: PolicyFile): string {
  const body = {
    torrents: torrents
      .map((torrent) => ({
        hostId: torrent.hostId,
        hash: torrent.hash,
        name: torrent.name,
        savePath: torrent.savePath,
        contentPath: torrent.contentPath,
        complete: torrent.progress >= 0.999,
      }))
      .sort((a, b) => `${a.hostId}:${a.hash}`.localeCompare(`${b.hostId}:${b.hash}`)),
    profiles: policy.profiles.map((profile) => ({
      contentKind: profile.contentKind,
      diskId: profile.diskId,
      folder: profile.folder,
      indexProfile: profile.indexProfile,
      postProcess: profile.postProcess,
      handbrake: profile.handbrake,
      compactAfterMove: profile.compactAfterMove,
    })),
    rules: policy.customRules.map((rule) => ({ pattern: rule.pattern, kind: rule.kind })),
  };
  return fnv(JSON.stringify(body));
}

export function buildDryRun(torrents: DryTorrent[], disks: DiskRecord[], policy: PolicyFile, now = Date.now()): DryRun {
  const items: DryItem[] = torrents.map((torrent) => {
    const classified = classify({
      name: torrent.name,
      path: torrent.contentPath || torrent.savePath,
      sizeBytes: torrent.size,
      customRules: policy.customRules,
    });
    const profile = policy.profiles.find((item) => item.contentKind === classified.kind);
    const disk = profile?.diskId ? disks.find((item) => item.id === profile.diskId) ?? null : null;
    const destinationPath = disk ? destinationFolder(disk, profile?.folder ?? "") : "";
    const relocatesViaSetLocation = Boolean(disk && destinationPath && normalize(destinationPath) !== normalize(torrent.savePath));
    return {
      hostId: torrent.hostId,
      hash: torrent.hash,
      name: torrent.name,
      kind: classified.kind,
      kindLabel: KIND_LABEL[classified.kind],
      reason: classified.reason,
      diskId: disk?.id ?? null,
      diskLabel: disk?.label ?? "диск не задан",
      currentPath: torrent.savePath,
      destinationPath: destinationPath || torrent.savePath,
      postProcess: profile?.postProcess ?? "none",
      detail: describe(profile, disk, classified.kind),
      deletes: false,
      relocatesViaSetLocation,
    };
  });
  return {
    items,
    deletesAnything: false,
    fingerprint: computeFingerprint(torrents, policy),
    generatedAt: now,
  };
}

function describe(profile: PolicyProfile | undefined, disk: DiskRecord | null, kind: ContentKind): string {
  if (!profile || profile.postProcess === "none") {
    if (kind.startsWith("game")) {
      return profile?.compactAfterMove
        ? "Индексация. Сжатие NTFS только после завершённого переноса и только если диск NTFS. Сейчас файлы не сжимаются и не удаляются."
        : "Индексация без сжатия. Vault и файловые системы кроме NTFS не сжимаются.";
    }
    if (!disk) return "Только индексация на текущем пути. Ничего не переносится и не удаляется.";
    return "Только индексация. Исходные файлы не удаляются.";
  }
  if (profile.postProcess === "handbrake") {
    const codec = profile.handbrake?.codec ?? "x264";
    const quality = profile.handbrake?.quality ?? 20;
    return `HandBrake ${codec}, качество ${quality}, на Mac или Windows — отдельный файл. Исходник остаётся. Готовая раздача переносится через setLocation, раздача продолжается.`;
  }
  return "Профиль просит сжатие NTFS. Оно не запускается само и не стирает исходник. На APFS и /Volumes/vault сжатие запрещено.";
}

function destinationFolder(disk: DiskRecord, folder: string): string {
  const mount = disk.mounts[0]?.mountPoint || disk.lastMount?.mountPoint || "";
  if (!mount) return folder;
  const os: HostOs = /\\/.test(mount) || /^[A-Za-z]:/.test(mount) ? "win32" : "darwin";
  if (!folder) return mount;
  return joinRemotePath(os, mount, folder);
}

function normalize(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

export async function projectTorrents(): Promise<DryTorrent[]> {
  const dashboard = await getDashboard();
  return dashboard.torrents.map((torrent) => ({
    hostId: torrent.hostId,
    hash: torrent.hash,
    name: torrent.name,
    savePath: torrent.savePath,
    contentPath: torrent.contentPath,
    progress: torrent.progress,
    size: torrent.size,
    os: torrent.hostOs,
  }));
}

export async function runDryRun(disks: DiskRecord[]): Promise<DryRun> {
  const policy = await loadPolicy();
  const torrents = await projectTorrents();
  const run = buildDryRun(torrents, disks, policy);
  await withLock("policy", async () => {
    const current = (await readPolicy()) ?? policy;
    current.dryRunFingerprint = run.fingerprint;
    current.lastDryRunAt = run.generatedAt;
    await writePolicy(current);
  });
  return run;
}

export async function enableAutomation(enabled: boolean): Promise<PolicyFile> {
  const disksNote = enabled ? await projectTorrents() : [];
  return withLock("policy", async () => {
    const policy = (await readPolicy()) ?? demoPolicy();
    if (!enabled) {
      policy.automationEnabled = false;
      await writePolicy(policy);
      return policy;
    }
    const fingerprint = computeFingerprint(disksNote, policy);
    if (!policy.dryRunFingerprint || policy.dryRunFingerprint !== fingerprint) {
      throw new SkladError(
        "validation",
        "Автоматика не включена: предпросмотр ещё не запускался или устарел. Обновите сухой прогон. Ничего не удалено.",
      );
    }
    policy.automationEnabled = true;
    await writePolicy(policy);
    return policy;
  });
}

export async function assertAutomationFresh(): Promise<{ policy: PolicyFile; torrents: DryTorrent[] }> {
  const torrents = await projectTorrents();
  const policy = await loadPolicy();
  if (!policy.automationEnabled) {
    throw new SkladError("validation", "Автоматика выключена. Сначала сухой прогон, затем включение. Ничего не удалено.");
  }
  const fingerprint = computeFingerprint(torrents, policy);
  if (policy.dryRunFingerprint !== fingerprint) {
    throw new SkladError(
      "validation",
      "Предпросмотр устарел. Новые действия не поставлены. Ничего не удалено.",
    );
  }
  return { policy, torrents };
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
