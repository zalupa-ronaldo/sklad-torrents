import type { BackgroundJob } from "@/lib/jobs/types";

type Listener = (jobs: BackgroundJob[]) => void;

const listeners = new Set<Listener>();

export function subscribeJobs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishJobs(jobs: BackgroundJob[]): void {
  const snapshot = jobs.map((job) => ({ ...job }));
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // A closed SSE stream must not break the queue.
    }
  }
}
