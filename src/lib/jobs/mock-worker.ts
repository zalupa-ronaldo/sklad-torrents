import type { JobStore } from "@/lib/jobs/engine";
import type { Job, JobHost, JobKind } from "@/lib/jobs/model";

const DEMO_BYTES: Record<JobKind, number> = {
  move: 8_000_000_000,
  copy: 8_000_000_000,
  index: 40_000_000_000,
  compact: 3_000_000_000,
  transcode: 12_000_000_000,
};

export interface MockWorkerOptions {
  intervalMs?: number;
  steps?: number;
  adoptOrphans?: boolean;
  shouldFail?: (job: Job) => boolean;
}

export interface WorkerHandle {
  stop: () => void;
}

let gate: Promise<void> | null = null;

export function setMockWorkerGateForTests(next: Promise<void> | null) {
  gate = next;
}

export function startMockWorker(store: JobStore, host: JobHost, options: MockWorkerOptions = {}): WorkerHandle {
  const intervalMs = options.intervalMs ?? positiveNumber(process.env.SKLAD_JOB_TICK_MS, 600);
  const steps = options.steps ?? 5;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let ticking = false;
  let adopted = false;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = arm(delay, () => {
      void loop();
    });
  };

  const loop = async () => {
    if (stopped || ticking) return;
    ticking = true;
    let claimed = false;
    try {
      if (!adopted) {
        adopted = true;
        if (options.adoptOrphans) await store.adoptOrphans(host);
      }
      if (stopped || controller.signal.aborted) return;
      const job = await store.claimNext(host);
      if (job?.workerToken) {
        claimed = true;
        await runMockJob(store, job, {
          intervalMs,
          steps,
          signal: controller.signal,
          shouldFail: options.shouldFail,
        });
      }
    } catch {
      // The demo worker stays up after a cancelled tick or a full disk in tests.
    } finally {
      ticking = false;
      schedule(claimed ? 30 : Math.min(intervalMs, 400));
    }
  };

  schedule(intervalMs);

  return {
    stop() {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    },
  };
}

export async function runMockJob(
  store: JobStore,
  job: Job,
  options: { intervalMs: number; steps: number; signal: AbortSignal; shouldFail?: (job: Job) => boolean },
): Promise<void> {
  const token = job.workerToken;
  if (!token) return;
  if (job.verified) {
    await store.complete(job.id, token);
    return;
  }
  await waitIfGated(options.signal);
  const total = job.progress.totalBytes > 0 ? job.progress.totalBytes : DEMO_BYTES[job.kind];
  const startStep = Math.min(options.steps - 1, Math.floor((job.progress.percent / 100) * options.steps));
  for (let step = startStep + 1; step <= options.steps; step += 1) {
    await sleep(options.intervalMs, options.signal);
    const processedBytes = Math.round((total * step) / options.steps);
    const updated = await store.updateProgress(job.id, token, {
      percent: Math.min(100, Math.round((step / options.steps) * 100)),
      processedBytes,
      totalBytes: total,
      speed: Math.max(1, Math.round(total / options.steps / Math.max(options.intervalMs / 1000, 0.05))),
      etaSeconds: Math.max(0, Math.round(((options.steps - step) * options.intervalMs) / 1000)),
      currentFile: currentFile(job),
    });
    if (!updated) return;
    if (step === startStep + 1 && options.shouldFail?.(updated)) {
      await store.fail(job.id, token, "Сбой проверки, исходник не трогали");
      return;
    }
  }
  const verified = await store.markVerified(job.id, token);
  if (!verified) return;
  await store.complete(job.id, token);
}

function currentFile(job: Job): string {
  const source = job.payload.source || job.payload.diskId || "каталог";
  const parts = source.split(/[/\\]/);
  return parts[parts.length - 1] || source;
}

async function waitIfGated(signal: AbortSignal) {
  if (!gate) return;
  await Promise.race([gate, abortPromise(signal)]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function arm(delay: number, fn: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, delay);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}
