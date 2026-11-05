import { FALLBACK_NOTE, resolveDisk } from "@/lib/scheduler/disk-key";
import { downloadPhase, type DownloadPhase } from "@/lib/scheduler/phase";
import {
  torrentKey,
  type DiskQueueView,
  type PlanInput,
  type QueueTorrentRef,
  type SchedulerPlan,
  type SchedulerTarget,
  type SchedulerTorrent,
} from "@/lib/scheduler/types";

interface Annotated {
  torrent: SchedulerTorrent;
  phase: DownloadPhase;
  key: string;
}

/**
 * One active download per physical disk.
 * Priority and queue order choose who starts next. They do not preempt the
 * single torrent that is already downloading. Several actives on one disk
 * (started outside the scheduler) collapse to the higher queue item.
 * Seeds are never paused or resumed here.
 */
export function planDownloads(input: PlanInput): SchedulerPlan {
  const groups = new Map<string, { disk: ReturnType<typeof resolveDisk>; items: Annotated[] }>();
  for (const torrent of input.torrents) {
    const disk = resolveDisk({
      hostId: torrent.hostId,
      hostOs: torrent.hostOs,
      savePath: torrent.savePath,
      catalog: input.catalog,
    });
    let group = groups.get(disk.key);
    if (!group) {
      group = { disk, items: [] };
      groups.set(disk.key, group);
    }
    group.items.push({ torrent, phase: downloadPhase(torrent), key: torrentKey(torrent) });
  }

  const pause: SchedulerTarget[] = [];
  const resume: SchedulerTarget[] = [];
  const queues: DiskQueueView[] = [];

  for (const group of groups.values()) {
    const order = input.order[group.disk.key] ?? [];
    const rank = (items: Annotated[]) =>
      [...items].sort((a, b) => compareRank(a, b, order, input.priority));
    const wantsSlot = (item: Annotated) => item.phase === "active" || item.phase === "paused" || item.phase === "queued";
    const manuals = group.items.filter((item) => item.torrent.userPaused && wantsSlot(item));
    const candidates = group.items.filter((item) => !item.torrent.userPaused && wantsSlot(item));
    const actives = candidates.filter((item) => item.phase === "active");

    let winner: Annotated | null = null;
    if (!group.disk.online) {
      for (const active of actives) pause.push(targetOf(active));
    } else if (actives.length === 1) {
      winner = actives[0];
    } else if (actives.length > 1) {
      const rankedActives = rank(actives);
      winner = rankedActives[0] ?? null;
      for (const active of rankedActives.slice(1)) pause.push(targetOf(active));
    } else {
      winner = rank(candidates)[0] ?? null;
      if (winner && winner.phase !== "active") resume.push(targetOf(winner));
    }

    for (const manual of manuals) {
      if (manual.phase === "active") pause.push(targetOf(manual));
    }

    const waiting = rank(candidates.filter((item) => item !== winner));
    queues.push({
      diskKey: group.disk.key,
      label: group.disk.label,
      online: group.disk.online,
      source: group.disk.source,
      active: winner ? toRef(winner, input.priority) : null,
      waiting: waiting.map((item) => toRef(item, input.priority)),
      manual: manuals.map((item) => toRef(item, input.priority)),
      seeding: group.items.filter((item) => item.phase === "seeding").map((item) => toRef(item, input.priority)),
      offlineReason: group.disk.online ? null : `Диск «${group.disk.label}» не подключён`,
      fallbackNote: group.disk.source === "fallback" ? FALLBACK_NOTE : null,
    });
  }

  queues.sort((a, b) => a.label.localeCompare(b.label, "ru") || a.diskKey.localeCompare(b.diskKey));
  return {
    pause: uniqueTargets(pause),
    resume: uniqueTargets(resume),
    queues,
  };
}

function compareRank(a: Annotated, b: Annotated, order: string[], priority: Record<string, number>): number {
  const pa = priority[a.key] ?? 0;
  const pb = priority[b.key] ?? 0;
  if (pa !== pb) return pb - pa;
  const ia = order.indexOf(a.key);
  const ib = order.indexOf(b.key);
  const oa = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
  const ob = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
  if (oa !== ob) return oa - ob;
  const byName = a.torrent.name.localeCompare(b.torrent.name, "ru");
  if (byName !== 0) return byName;
  return a.key.localeCompare(b.key);
}

function toRef(item: Annotated, priority: Record<string, number>): QueueTorrentRef {
  const torrent = item.torrent;
  return {
    key: item.key,
    hostId: torrent.hostId,
    hash: torrent.hash,
    name: torrent.name,
    hostName: torrent.hostName,
    savePath: torrent.savePath,
    progress: torrent.progress,
    state: torrent.state,
    rawState: torrent.rawState,
    priority: priority[item.key] ?? 0,
  };
}

function targetOf(item: Annotated): SchedulerTarget {
  return { hostId: item.torrent.hostId, hash: item.torrent.hash };
}

function uniqueTargets(items: SchedulerTarget[]): SchedulerTarget[] {
  const seen = new Set<string>();
  const unique: SchedulerTarget[] = [];
  for (const item of items) {
    const key = `${item.hostId}:${item.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  unique.sort((a, b) => a.hostId.localeCompare(b.hostId) || a.hash.localeCompare(b.hash));
  return unique;
}
