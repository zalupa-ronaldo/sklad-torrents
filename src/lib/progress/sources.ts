import type { JobSnapshot, JobSource } from "@/lib/progress/types";

const sources: JobSource[] = [];

/**
 * Seam for HandBrake, CompactGUI, copy-to-SSD, and the NTFS indexer.
 * Call this from the adapter module once it exists. A failing source is
 * skipped so one engine cannot blank the progress page.
 */
export function registerJobSource(source: JobSource): void {
  const index = sources.findIndex((item) => item.id === source.id);
  if (index >= 0) sources[index] = source;
  else sources.push(source);
}

export function registeredJobSources(): readonly JobSource[] {
  return sources;
}

export async function listRegisteredJobs(): Promise<JobSnapshot[]> {
  const jobs: JobSnapshot[] = [];
  for (const source of sources) {
    try {
      jobs.push(...(await source.list()));
    } catch {
      jobs.push({
        id: `source-error__${source.id}`,
        kind: "index",
        title: source.id,
        status: "error",
        progress: 0,
        processedBytes: 0,
        totalBytes: 0,
        speed: 0,
        eta: 8_640_000,
        currentFile: null,
        host: null,
        diskLabel: null,
        outputPath: null,
        error: "Источник операций не ответил. Остальные задачи на месте.",
        capabilities: { pause: false, resume: false, cancel: false },
        pauseUnsupportedReason: null,
        updatedAt: Date.now(),
      });
    }
  }
  return jobs;
}
