import { setInterval as scheduleInterval } from "node:timers";

import type { QbittorrentClient } from "@/lib/qbittorrent/client";
import { clientFor, getDashboard, requireHost } from "@/lib/qbittorrent/service";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { assertHash } from "@/lib/qbittorrent/paths";
import type { DashboardPayload } from "@/lib/qbittorrent/types";
import { loadDriveCatalog } from "@/lib/drives/catalog";
import type { CatalogDisk } from "@/lib/drives/types";
import { planDownloads } from "@/lib/scheduler/plan";
import { downloadPhase } from "@/lib/scheduler/phase";
import { loadSchedulerPrefs, saveSchedulerPrefs, setUserPaused } from "@/lib/scheduler/store";
import {
  NEXT_PRIORITY,
  torrentKey,
  type PlanInput,
  type SchedulerPlan,
  type SchedulerPrefs,
} from "@/lib/scheduler/types";

export interface SchedulerTick {
  plan: SchedulerPlan;
  dashboard: DashboardPayload;
  catalog: CatalogDisk[];
  /** Decisions from the pass that talked to qBittorrent. */
  applied: Pick<SchedulerPlan, "pause" | "resume">;
}

const globalStore = globalThis as typeof globalThis & {
  __skladSchedulerTimer?: ReturnType<typeof scheduleInterval>;
};

let inflight: Promise<SchedulerTick> | null = null;

export function ensureSchedulerLoop(): void {
  if (process.env.VITEST) return;
  if (globalStore.__skladSchedulerTimer) return;
  const timer = scheduleInterval(() => {
    void tickScheduler().catch(() => undefined);
  }, 10_000);
  timer.unref();
  globalStore.__skladSchedulerTimer = timer;
}

export function tickScheduler(): Promise<SchedulerTick> {
  if (inflight) return inflight;
  inflight = runTick().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function previewScheduler(): Promise<SchedulerPlan> {
  const loaded = await loadContext();
  return planDownloads(loaded.input);
}

export async function reorderQueue(diskKey: string, key: string, direction: "up" | "down"): Promise<SchedulerTick> {
  const loaded = await loadContext();
  const plan = planDownloads(loaded.input);
  const queue = plan.queues.find((item) => item.diskKey === diskKey);
  if (!queue) throw new QbittorrentError("not_found", "Диск в очереди не найден.");
  const waiting = queue.waiting.map((item) => item.key);
  const index = waiting.indexOf(key);
  const next = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || next < 0 || next >= waiting.length) return tickScheduler();
  const swapped = [...waiting];
  const current = swapped[index];
  const neighbor = swapped[next];
  if (current === undefined || neighbor === undefined) return tickScheduler();
  swapped[index] = neighbor;
  swapped[next] = current;
  const prefs = await loadSchedulerPrefs();
  prefs.order[diskKey] = [...(queue.active ? [queue.active.key] : []), ...swapped, ...queue.manual.map((item) => item.key)];
  clearNextPriority(prefs, new Set(prefs.order[diskKey]));
  await saveSchedulerPrefs(prefs);
  return tickScheduler();
}

export async function prioritizeNext(diskKey: string, key: string): Promise<SchedulerTick> {
  const loaded = await loadContext();
  const plan = planDownloads(loaded.input);
  const queue = plan.queues.find((item) => item.diskKey === diskKey);
  if (!queue) throw new QbittorrentError("not_found", "Диск в очереди не найден.");
  const known = new Set([
    ...(queue.active ? [queue.active.key] : []),
    ...queue.waiting.map((item) => item.key),
    ...queue.manual.map((item) => item.key),
  ]);
  if (!known.has(key)) throw new QbittorrentError("not_found", "Раздачи нет в очереди этого диска.");
  const prefs = await loadSchedulerPrefs();
  for (const candidate of known) {
    if ((prefs.priority[candidate] ?? 0) >= NEXT_PRIORITY) prefs.priority[candidate] = 0;
  }
  prefs.priority[key] = NEXT_PRIORITY;
  const rest = [...known].filter((item) => item !== key && item !== queue.active?.key);
  const orderedRest = rest.sort((a, b) => {
    const current = prefs.order[diskKey] ?? [];
    const ia = current.indexOf(a);
    const ib = current.indexOf(b);
    return (ia === -1 ? 10_000 : ia) - (ib === -1 ? 10_000 : ib);
  });
  prefs.order[diskKey] = [...(queue.active ? [queue.active.key] : []), key, ...orderedRest];
  await saveSchedulerPrefs(prefs);
  return tickScheduler();
}

/**
 * Resume a torrent without opening a second download on its disk.
 * Seeds resume immediately. A download resumes only when the slot is free;
 * otherwise it stays queued and the caller gets a Russian notice.
 */
export async function resumeRespectingDisk(hostId: string, hash: string): Promise<{ notice?: string }> {
  const safe = assertHash(hash);
  await setUserPaused(hostId, safe, false);
  const loaded = await loadContext();
  const torrent = loaded.dashboard.torrents.find((item) => item.hostId === hostId && item.hash === safe);
  if (!torrent) throw new QbittorrentError("not_found", "Раздача не найдена на этом хосте.");
  const phase = downloadPhase(torrent);
  const host = await requireHost(hostId);
  const client = clientFor(host);
  if (phase === "seeding" || phase === "complete") {
    await client.resume([safe]);
    return {};
  }
  const plan = planDownloads(loaded.input);
  const willRun =
    plan.resume.some((item) => item.hostId === hostId && item.hash === safe) ||
    plan.queues.some((queue) => queue.active?.hostId === hostId && queue.active.hash === safe);
  if (!willRun) {
    return { notice: "На этом диске уже идёт загрузка. Раздача подождёт в очереди." };
  }
  await client.resume([safe]);
  await tickScheduler();
  return {};
}

async function runTick(): Promise<SchedulerTick> {
  const loaded = await loadContext();
  const first = planDownloads(loaded.input);
  if (first.pause.length === 0 && first.resume.length === 0) {
    return { plan: first, dashboard: loaded.dashboard, catalog: loaded.catalog, applied: { pause: [], resume: [] } };
  }
  await applyDecisions(first, loaded.dashboard);
  const again = await loadContext();
  return {
    plan: planDownloads(again.input),
    dashboard: again.dashboard,
    catalog: again.catalog,
    applied: { pause: first.pause, resume: first.resume },
  };
}

async function loadContext(): Promise<{ input: PlanInput; dashboard: DashboardPayload; catalog: CatalogDisk[] }> {
  const [dashboard, catalog, prefs] = await Promise.all([getDashboard(), loadDriveCatalog(), loadSchedulerPrefs()]);
  const paused = new Set(prefs.userPaused);
  return {
    dashboard,
    catalog,
    input: {
      torrents: dashboard.torrents.map((torrent) => ({
        hostId: torrent.hostId,
        hostName: torrent.hostName,
        hostOs: torrent.hostOs,
        hash: torrent.hash,
        name: torrent.name,
        savePath: torrent.savePath,
        state: torrent.state,
        rawState: torrent.rawState,
        progress: torrent.progress,
        userPaused: paused.has(torrentKey(torrent)),
      })),
      catalog,
      order: prefs.order,
      priority: prefs.priority,
    },
  };
}

async function applyDecisions(plan: SchedulerPlan, dashboard: DashboardPayload): Promise<void> {
  const hosts = new Map(dashboard.hosts.map((host) => [host.id, host]));
  const byHost = new Map<string, { pause: string[]; resume: string[] }>();
  const bucket = (hostId: string) => {
    let entry = byHost.get(hostId);
    if (!entry) {
      entry = { pause: [], resume: [] };
      byHost.set(hostId, entry);
    }
    return entry;
  };
  for (const item of plan.pause) bucket(item.hostId).pause.push(item.hash);
  for (const item of plan.resume) bucket(item.hostId).resume.push(item.hash);
  await Promise.all(
    [...byHost].map(async ([hostId, actions]) => {
      if (!hosts.get(hostId)?.online) return;
      try {
        const host = await requireHost(hostId);
        const client: QbittorrentClient = clientFor(host);
        if (actions.pause.length > 0) await client.pause(actions.pause);
        if (actions.resume.length > 0) await client.resume(actions.resume);
      } catch (error) {
        console.error(`Планировщик не смог обновить хост ${hostId}`, error);
      }
    }),
  );
}

function clearNextPriority(prefs: SchedulerPrefs, keys: Set<string>): void {
  for (const key of keys) {
    if ((prefs.priority[key] ?? 0) >= NEXT_PRIORITY) prefs.priority[key] = 0;
  }
}
