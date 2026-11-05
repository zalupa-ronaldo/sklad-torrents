import { startMacAgent } from "../../../agents/mac-agent";
import { startPcAgent } from "../../../agents/pc-agent";
import { getJobStore, resetJobStoreForTests } from "@/lib/jobs/engine";
import { setMockWorkerGateForTests } from "@/lib/jobs/mock-worker";

let stops: Array<() => void> = [];
let started = false;

export function ensureJobWorkers(): void {
  if (started) return;
  if (process.env.SKLAD_JOB_WORKERS === "0") return;
  if (process.env.VITEST && process.env.SKLAD_JOB_WORKERS !== "1") return;
  started = true;
  const store = getJobStore();
  const intervalMs = Number(process.env.SKLAD_JOB_TICK_MS || 600);
  const shared = { intervalMs, adoptOrphans: true };
  stops = [startMacAgent(store, shared).stop, startPcAgent(store, shared).stop];
}

export function resetJobRuntimeForTests(): void {
  for (const stop of stops) stop();
  stops = [];
  started = false;
  setMockWorkerGateForTests(null);
  resetJobStoreForTests();
}
