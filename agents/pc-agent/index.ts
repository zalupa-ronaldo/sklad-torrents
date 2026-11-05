import { startMockWorker, type MockWorkerOptions, type WorkerHandle } from "../../src/lib/jobs/mock-worker";
import { getJobStore, type JobStore } from "../../src/lib/jobs/engine";

export const PC_AGENT_HOST = "pc-agent" as const;

export function startPcAgent(store: JobStore = getJobStore(), options: MockWorkerOptions = {}): WorkerHandle {
  return startMockWorker(store, PC_AGENT_HOST, options);
}
