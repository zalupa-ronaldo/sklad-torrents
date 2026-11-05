import { startMockWorker, type MockWorkerOptions, type WorkerHandle } from "../../src/lib/jobs/mock-worker";
import { getJobStore, type JobStore } from "../../src/lib/jobs/engine";

export const MAC_AGENT_HOST = "mac-local" as const;

export function startMacAgent(store: JobStore = getJobStore(), options: MockWorkerOptions = {}): WorkerHandle {
  return startMockWorker(store, MAC_AGENT_HOST, options);
}
