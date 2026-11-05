import { listDisks } from "@/lib/kernel/catalog";
import { readJsonFile, writeJsonFile } from "@/lib/kernel/json-file";
import { withLock } from "@/lib/kernel/lock";
import { emptyPrefs, nextPausedSet, planScheduler, type SlotPlan } from "@/lib/kernel/scheduler";
import type { SchedulerPrefs } from "@/lib/kernel/types";
import { asSlotDisk } from "@/lib/kernel/volume";
import { getDashboard, pauseTorrent, resumeTorrent } from "@/lib/qbittorrent/service";

const FILE = "scheduler.json";

export async function loadPrefs(): Promise<SchedulerPrefs> {
  return withLock("scheduler", async () => normalizePrefs(await readJsonFile<SchedulerPrefs>(FILE)));
}

export async function ensureDemoPrefs(): Promise<SchedulerPrefs> {
  return withLock("scheduler", async () => {
    const existing = await readJsonFile<SchedulerPrefs>(FILE);
    if (existing) return normalizePrefs(existing);
    const prefs = emptyPrefs();
    await writeJsonFile(FILE, prefs);
    return prefs;
  });
}

export async function updatePrefs(patch: Partial<SchedulerPrefs>): Promise<SchedulerPrefs> {
  return withLock("scheduler", async () => {
    const current = normalizePrefs(await readJsonFile<SchedulerPrefs>(FILE));
    const next: SchedulerPrefs = {
      order: patch.order ?? current.order,
      overrideNext: patch.overrideNext ?? current.overrideNext,
      schedulerPaused: patch.schedulerPaused ?? current.schedulerPaused,
    };
    await writeJsonFile(FILE, next);
    return next;
  });
}

function normalizePrefs(value: SchedulerPrefs | null): SchedulerPrefs {
  if (!value) return emptyPrefs();
  return {
    order: value.order ?? {},
    overrideNext: value.overrideNext ?? {},
    schedulerPaused: Array.isArray(value.schedulerPaused) ? value.schedulerPaused : [],
  };
}

export async function previewScheduler(): Promise<SlotPlan[]> {
  const [dashboard, disks, prefs] = await Promise.all([getDashboard(), listDisks(), loadPrefs()]);
  return planScheduler(
    dashboard.torrents.map((torrent) => ({
      hostId: torrent.hostId,
      hash: torrent.hash,
      name: torrent.name,
      state: torrent.state,
      rawState: torrent.rawState,
      savePath: torrent.savePath,
      progress: torrent.progress,
      dlspeed: torrent.dlspeed,
      os: torrent.hostOs,
    })),
    disks.map(asSlotDisk),
    prefs,
  );
}

export async function applyScheduler(): Promise<{ plans: SlotPlan[]; warnings: string[] }> {
  const prefs = await loadPrefs();
  const plans = await previewScheduler();
  const warnings: string[] = [];
  for (const action of plans.flatMap((plan) => plan.actions)) {
    try {
      if (action.action === "pause") await pauseTorrent(action.hostId, action.hash);
      if (action.action === "resume") await resumeTorrent(action.hostId, action.hash);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Не удалось поправить раздачу.");
    }
  }
  await updatePrefs({ ...prefs, schedulerPaused: nextPausedSet(prefs, plans) });
  return { plans, warnings };
}
