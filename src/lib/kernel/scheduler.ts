import type { HostOs, NormalizedState } from "@/lib/qbittorrent/types";

import type { SchedulerPrefs } from "@/lib/kernel/types";
import { resolveSlot, type SlotDisk, type SlotRef } from "@/lib/kernel/volume";

export interface SchedTorrent {
  hostId: string;
  hash: string;
  name: string;
  state: NormalizedState;
  rawState: string;
  savePath: string;
  progress: number;
  dlspeed: number;
  os: HostOs;
}

export interface SlotTorrent {
  hostId: string;
  hash: string;
  name: string;
  rawState: string;
}

export interface SlotAction {
  hostId: string;
  hash: string;
  action: "resume" | "pause" | "keep";
}

export interface SlotPlan {
  key: string;
  label: string;
  mode: SlotRef["mode"];
  online: boolean;
  note: string | null;
  diskId: string | null;
  active: SlotTorrent | null;
  queued: SlotTorrent[];
  seeding: SlotTorrent[];
  actions: SlotAction[];
}

export function emptyPrefs(): SchedulerPrefs {
  return { order: {}, overrideNext: {}, schedulerPaused: [] };
}

export function torrentKey(torrent: { hostId: string; hash: string }): string {
  return `${torrent.hostId}:${torrent.hash}`;
}

function isSeeding(torrent: SchedTorrent): boolean {
  return (
    torrent.state === "seeding" ||
    torrent.rawState === "queuedUP" ||
    torrent.rawState === "pausedUP" ||
    torrent.rawState === "stoppedUP" ||
    torrent.rawState === "forcedUP" ||
    torrent.rawState === "stalledUP"
  );
}

function isActiveDownload(torrent: SchedTorrent): boolean {
  return (
    torrent.state === "downloading" ||
    torrent.state === "metadata" ||
    torrent.state === "stalled" ||
    torrent.rawState === "checkingDL" ||
    torrent.rawState === "allocating" ||
    torrent.rawState === "forcedDL"
  );
}

function isUserPaused(torrent: SchedTorrent, prefs: SchedulerPrefs): boolean {
  const parked = prefs.schedulerPaused.includes(torrentKey(torrent));
  const paused = torrent.rawState === "pausedDL" || torrent.rawState === "stoppedDL" || (torrent.state === "paused" && !isSeeding(torrent));
  return paused && !parked;
}

function isDownloadCandidate(torrent: SchedTorrent, prefs: SchedulerPrefs): boolean {
  if (isSeeding(torrent) || torrent.state === "missing" || torrent.state === "error" || torrent.state === "moving") {
    return false;
  }
  if (isUserPaused(torrent, prefs)) return false;
  if (isActiveDownload(torrent)) return true;
  if (torrent.rawState === "queuedDL") return true;
  if (
    prefs.schedulerPaused.includes(torrentKey(torrent)) &&
    (torrent.rawState === "pausedDL" || torrent.rawState === "stoppedDL" || torrent.state === "paused")
  ) {
    return true;
  }
  return false;
}

function refOf(torrent: SchedTorrent): SlotTorrent {
  return { hostId: torrent.hostId, hash: torrent.hash, name: torrent.name, rawState: torrent.rawState };
}

/**
 * One actively downloading torrent per slot. Slots are physical disks when
 * the catalog matches serial+UUID, otherwise host + volume root.
 * Seeding is listed and never paused by the cap.
 */
export function planScheduler(torrents: SchedTorrent[], disks: SlotDisk[], prefs: SchedulerPrefs): SlotPlan[] {
  const groups = new Map<string, { slot: SlotRef; items: SchedTorrent[] }>();
  for (const torrent of torrents) {
    const slot = resolveSlot(disks, torrent.hostId, torrent.os, torrent.savePath);
    const group = groups.get(slot.key);
    if (group) group.items.push(torrent);
    else groups.set(slot.key, { slot, items: [torrent] });
  }

  const plans: SlotPlan[] = [];
  for (const { slot, items } of groups.values()) {
    const seeding = items.filter(isSeeding).map(refOf);
    const candidates = items.filter((torrent) => isDownloadCandidate(torrent, prefs));
    const order = prefs.order[slot.key] ?? [];
    const override = prefs.overrideNext[slot.key] ?? null;
    const ranked = [...candidates].sort((a, b) => compareCandidates(a, b, order, override));

    let chosen: SchedTorrent | null = null;
    if (slot.online && ranked.length > 0) chosen = ranked[0] ?? null;
    const queued = ranked.filter((torrent) => torrent !== chosen).map(refOf);
    const actions: SlotAction[] = [];

    for (const torrent of items.filter(isSeeding)) {
      actions.push({ hostId: torrent.hostId, hash: torrent.hash, action: "keep" });
    }

    if (!slot.online) {
      for (const torrent of candidates) {
        actions.push({
          hostId: torrent.hostId,
          hash: torrent.hash,
          action: isActiveDownload(torrent) ? "pause" : "keep",
        });
      }
    } else {
      for (const torrent of candidates) {
        if (torrent === chosen) {
          actions.push({
            hostId: torrent.hostId,
            hash: torrent.hash,
            action: isActiveDownload(torrent) ? "keep" : "resume",
          });
        } else if (isActiveDownload(torrent)) {
          actions.push({ hostId: torrent.hostId, hash: torrent.hash, action: "pause" });
        } else {
          actions.push({ hostId: torrent.hostId, hash: torrent.hash, action: "keep" });
        }
      }
    }

    const resumes = actions.filter((action) => action.action === "resume");
    if (resumes.length > 1) {
      throw new Error("Планировщик выбрал больше одной загрузки на слот.");
    }

    plans.push({
      key: slot.key,
      label: slot.label,
      mode: slot.mode,
      online: slot.online,
      note: slot.note,
      diskId: slot.diskId,
      active: chosen ? refOf(chosen) : null,
      queued,
      seeding,
      actions,
    });
  }

  plans.sort((a, b) => a.label.localeCompare(b.label, "ru"));
  return plans;
}

function compareCandidates(a: SchedTorrent, b: SchedTorrent, order: string[], override: string | null): number {
  const rank = (torrent: SchedTorrent) => {
    const key = torrentKey(torrent);
    if (override === key) return 0;
    const index = order.indexOf(key);
    if (index >= 0) return 10 + index;
    if (isActiveDownload(torrent)) return 1_000;
    return 2_000;
  };
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  if (b.dlspeed !== a.dlspeed) return b.dlspeed - a.dlspeed;
  if (b.progress !== a.progress) return b.progress - a.progress;
  return a.name.localeCompare(b.name, "ru");
}

export function nextPausedSet(prefs: SchedulerPrefs, plans: SlotPlan[]): string[] {
  const paused = new Set(prefs.schedulerPaused);
  for (const plan of plans) {
    for (const action of plan.actions) {
      const key = `${action.hostId}:${action.hash}`;
      if (action.action === "pause") paused.add(key);
      if (action.action === "resume" || action.action === "keep") {
        const stillActive = plan.active && torrentKey(plan.active) === key;
        if (stillActive || action.action === "resume") paused.delete(key);
      }
    }
  }
  return [...paused];
}

export function countActive(plans: SlotPlan[]): number {
  return plans.filter((plan) => plan.active).length;
}
