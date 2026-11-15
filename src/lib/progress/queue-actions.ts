import { JobError } from "@/lib/jobs/errors";
import { getJobStore } from "@/lib/jobs/engine";
import type { Job, JobHost } from "@/lib/jobs/model";

import type { LoadPolicy, QueueScope } from "@/lib/progress/control";
import { hostIsQuiet, readControl, sanitizeLoad, snapshotHost, writeControl } from "@/lib/progress/control";

/** Pause every queued task. A file already open for HandBrake is left intact. */
export async function pauseAll(): Promise<{ affected: number; notice: string }> {
  return controlQueue("pause", "all");
}

export async function controlQueue(action: "pause" | "resume" | "cancel", scope: QueueScope): Promise<{ affected: number; notice: string }> {
  const stored = await controlStoredJobs(action, scope);
  const visible = await controlVisibleJobs(action, scope);
  const notice = action === "cancel"
    ? "Отменено. Файлы на диске не удалялись."
    : action === "pause"
      ? "Пауза сохранится после перезапуска. Текущий файл HandBrake дописывается, следующий не стартует, оригинал не заменяется."
      : "Очередь продолжается с сохранённого места. Пауза, которую поставили вручную, не снимается.";
  return { affected: stored.affected + visible, notice };
}

export async function controlStoredJobs(action: "pause" | "resume" | "cancel", scope: QueueScope): Promise<{ affected: number; finishing: number }> {
  const store = getJobStore();
  const control = await readControl();
  const jobs = await listAll();
  let affected = 0;
  let finishing = 0;
  if (action === "pause") {
    if (scope === "all") control.paused = true;
    else control.hosts[scope].paused = true;
    for (const job of jobs) {
      if (!hostInScope(job.host, scope)) continue;
      if (job.kind === "transcode" && job.state === "running") {
        finishing += 1;
        continue;
      }
      if (job.state !== "queued" && job.state !== "running") continue;
      await store.pause(job.id);
      if (!control.pausedByQueue.includes(job.id)) control.pausedByQueue.push(job.id);
      affected += 1;
    }
  } else if (action === "resume") {
    if (scope === "all") control.paused = false;
    else control.hosts[scope].paused = false;
    const remain: string[] = [];
    for (const id of control.pausedByQueue) {
      const job = jobs.find((item) => item.id === id) ?? (await store.get(id));
      if (!job || !hostInScope(job.host, scope)) {
        if (job || id) remain.push(id);
        continue;
      }
      if (job.state !== "paused") continue;
      try {
        await store.resume(id);
        affected += 1;
      } catch (error) {
        if (!(error instanceof JobError)) throw error;
        remain.push(id);
      }
    }
    control.pausedByQueue = remain;
  } else {
    const dropped = new Set<string>();
    for (const job of jobs) {
      if (!hostInScope(job.host, scope)) continue;
      if (job.state !== "queued" && job.state !== "running" && job.state !== "paused") continue;
      await store.cancel(job.id);
      dropped.add(job.id);
      affected += 1;
    }
    control.pausedByQueue = control.pausedByQueue.filter((id) => !dropped.has(id));
    control.pausedByYield = control.pausedByYield.filter((id) => !dropped.has(id));
  }
  await writeControl(control);
  return { affected, finishing };
}

export async function saveLoad(input: unknown): Promise<LoadPolicy> {
  const control = await readControl();
  const previous = control.load;
  control.load = sanitizeLoad(input, previous);
  await applyYield(control.load, previous);
  const fresh = await readControl();
  fresh.load = control.load;
  await writeControl(fresh);
  return fresh.load;
}

async function applyYield(next: LoadPolicy, previous: LoadPolicy): Promise<void> {
  const store = getJobStore();
  const control = await readControl();
  const jobs = await listAll();
  for (const job of jobs) {
    if (job.kind !== "transcode" && job.kind !== "compact") continue;
    if (job.host !== "mac-local" && job.host !== "pc-agent") continue;
    const busy = hostIsQuiet(next, job.host);
    const wasBusy = hostIsQuiet(previous, job.host);
    if (!busy || wasBusy) continue;
    if (job.kind === "transcode" && job.state === "running") continue;
    if (job.state !== "queued" && job.state !== "running") continue;
    await store.pause(job.id);
    if (!control.pausedByYield.includes(job.id)) control.pausedByYield.push(job.id);
  }
  const remain: string[] = [];
  for (const id of control.pausedByYield) {
    const job = await store.get(id);
    if (!job) continue;
    const busy = (job.host === "mac-local" || job.host === "pc-agent") && hostIsQuiet(next, job.host);
    if (busy) {
      remain.push(id);
      continue;
    }
    if (control.paused || control.hosts[job.host]?.paused) {
      if (!control.pausedByQueue.includes(id)) control.pausedByQueue.push(id);
      continue;
    }
    if (job.state === "paused") {
      try {
        await store.resume(id);
      } catch (error) {
        if (!(error instanceof JobError)) throw error;
      }
    }
  }
  control.pausedByYield = remain;
  control.load = next;
  await writeControl(control);
}

async function controlVisibleJobs(action: "pause" | "resume" | "cancel", scope: QueueScope): Promise<number> {
  try {
    const { getProgressPayload, performJobAction } = await import("@/lib/progress/jobs");
    const payload = await getProgressPayload();
    const control = await readControl();
    let affected = 0;
    for (const job of payload.jobs) {
      if (job.id.startsWith("job_") || job.id.startsWith("torrent__")) continue;
      const host = snapshotHost(job.host);
      if (!host || !hostInScope(host, scope)) continue;
      if (job.status !== "running" && job.status !== "paused" && job.status !== "queued") continue;
      if (action === "resume" && !control.pausedByQueue.includes(job.id)) continue;
      if (action === "pause" && job.kind === "transcode" && job.status === "running") continue;
      if (action === "pause" && !job.capabilities.pause) continue;
      if (action === "resume" && !job.capabilities.resume) continue;
      if (action === "cancel" && !job.capabilities.cancel) continue;
      try {
        await performJobAction(job.id, action);
        if (action === "pause" && !control.pausedByQueue.includes(job.id)) control.pausedByQueue.push(job.id);
        if (action !== "pause") control.pausedByQueue = control.pausedByQueue.filter((id) => id !== job.id);
        affected += 1;
      } catch {
        // A torrent cannot be removed from here. The file queue is already updated.
      }
    }
    await writeControl(control);
    return affected;
  } catch {
    return 0;
  }
}

async function listAll(): Promise<Job[]> {
  const store = getJobStore();
  const jobs: Job[] = [];
  let offset = 0;
  for (;;) {
    const page = await store.list({ offset, limit: 100 });
    jobs.push(...page.jobs);
    if (page.nextOffset === null) return jobs;
    offset = page.nextOffset;
  }
}

function hostInScope(host: JobHost, scope: QueueScope): boolean {
  if (scope === "all") return true;
  return host === scope;
}
