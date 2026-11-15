import { loadDriveCatalog } from "@/lib/drives/catalog";
import { ensureAutomaticPolicies } from "@/lib/policies/auto-runner";
import { loadPolicy } from "@/lib/policies/store";
import { getDashboard } from "@/lib/qbittorrent/service";
import type { HostOs } from "@/lib/qbittorrent/types";

import type { PipelineSeed } from "@/lib/scheduler/auto-queue";
import {
  enqueuePipelineRun,
  pipelineView,
  rememberDiskOnline,
  rememberKey,
  rememberedDiskOnline,
  rememberedKeys,
  resumeDeferredRuns,
} from "@/lib/scheduler/auto-queue";
import { isSkippedVolume } from "@/lib/scheduler/skipped-volume";

export interface TriggerTorrent {
  hostId: string;
  hash: string;
  name: string;
  savePath: string;
  progress: number;
  state: string;
  os: HostOs;
}

export interface TriggerDisk {
  id: string;
  label: string;
  online: boolean;
  hostId: string;
  mounts: { path: string; os: HostOs }[];
}

export function selectTriggers(input: {
  torrents: TriggerTorrent[];
  disks: TriggerDisk[];
  seen: ReadonlySet<string>;
  diskOnline: Record<string, boolean>;
}): { seeds: PipelineSeed[]; remember: string[]; skippedVolume: number; diskOnline: Record<string, boolean> } {
  const seeds: PipelineSeed[] = [];
  const remember: string[] = [];
  let skippedVolume = 0;
  const diskOnline = { ...input.diskOnline };

  for (const torrent of input.torrents) {
    const key = `torrent:${torrent.hostId}:${torrent.hash}`;
    if (isSkippedVolume(torrent.savePath)) {
      if (!input.seen.has(key)) {
        skippedVolume += 1;
        remember.push(key);
      }
      continue;
    }
    if (input.seen.has(key)) continue;
    if (!finished(torrent.progress, torrent.state)) continue;
    seeds.push({
      trigger: "torrent",
      key,
      title: torrent.name,
      hostId: torrent.hostId,
      hash: torrent.hash,
      diskId: null,
      sourcePath: torrent.savePath,
      os: torrent.os,
      name: torrent.name,
    });
  }

  for (const disk of input.disks) {
    const id = disk.id || disk.label;
    const mount = disk.mounts.find((item) => item.path && !isSkippedVolume(item.path));
    const onlySkipped = disk.mounts.length > 0 && disk.mounts.every((item) => isSkippedVolume(item.path));
    if (onlySkipped) {
      if (diskOnline[id] !== true) skippedVolume += 1;
      diskOnline[id] = true;
      continue;
    }
    const online = disk.online && Boolean(mount);
    const wasOnline = diskOnline[id] === true;
    diskOnline[id] = online;
    if (!online || wasOnline || !mount) continue;
    seeds.push({
      trigger: "disk",
      key: `disk:${id}`,
      title: disk.label || "Диск",
      hostId: disk.hostId,
      hash: "",
      diskId: disk.id || null,
      sourcePath: mount.path,
      os: mount.os,
      name: disk.label || "Диск",
    });
  }

  return { seeds, remember, skippedVolume, diskOnline };
}

let observing = false;
let watchQueued = false;
let lastWatch = 0;
let scheduleWatch: (fn: () => void) => void = (fn) => {
  setImmediate(fn);
};

export function setWatchSchedulerForTests(fn: ((callback: () => void) => void) | null): void {
  scheduleWatch = fn ?? ((callback) => { setImmediate(callback); });
  watchQueued = false;
}

/** Ask the pipeline to look at disks and finished torrents on a later turn. */
export function scheduleAutoPipeline(): void {
  if (watchQueued) return;
  watchQueued = true;
  scheduleWatch(() => {
    watchQueued = false;
    const now = Date.now();
    if (lastWatch !== 0 && now - lastWatch < 8_000) return;
    lastWatch = now;
    void observeAutomation().catch((error) => {
      console.error("Авторежим Склада:", error instanceof Error ? error.message : "сбой");
    });
  });
}

export async function observeAutomation(): Promise<{ enqueued: number; skippedVolume: number }> {
  if (observing) return { enqueued: 0, skippedVolume: 0 };
  observing = true;
  try {
    await pipelineView();
    resumeDeferredRuns();
    await ensureAutomaticPolicies();
    const policy = await loadPolicy();
    if (!policy.automationEnabled) return { enqueued: 0, skippedVolume: 0 };
    const [dashboard, disks] = await Promise.all([getDashboard(), loadDriveCatalog()]);
    const hosts = new Map(dashboard.hosts.map((host) => [host.id, host.os]));
    const selected = selectTriggers({
      torrents: dashboard.torrents.map((torrent) => ({
        hostId: torrent.hostId,
        hash: torrent.hash,
        name: torrent.name,
        savePath: torrent.savePath,
        progress: torrent.progress,
        state: torrent.state,
        os: hosts.get(torrent.hostId) ?? "darwin",
      })),
      disks: disks.map((disk) => ({
        id: disk.id || `${disk.serial}:${disk.uuid}`,
        label: disk.label,
        online: disk.online,
        hostId: disk.mounts.find((mount) => mount.hostId)?.hostId ?? "",
        mounts: disk.mounts.map((mount) => ({ path: mount.path, os: mount.os })),
      })),
      seen: new Set(rememberedKeys()),
      diskOnline: rememberedDiskOnline(),
    });
    let enqueued = 0;
    for (const seed of selected.seeds) {
      const run = enqueuePipelineRun(seed);
      if (run?.status === "queued") enqueued += 1;
    }
    for (const key of selected.remember) rememberKey(key);
    rememberDiskOnline(selected.diskOnline);
    return { enqueued, skippedVolume: selected.skippedVolume };
  } finally {
    observing = false;
  }
}

function finished(progress: number, state: string): boolean {
  if (!(progress >= 0.999)) return false;
  return state !== "error" && state !== "missing" && state !== "moving";
}
