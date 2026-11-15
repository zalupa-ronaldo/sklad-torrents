import { getJobStore } from "@/lib/jobs/engine";
import type { JobHost } from "@/lib/jobs/model";

import type { LoadPolicy, QueueControl } from "@/lib/progress/control";
import { readControl, snapshotHost } from "@/lib/progress/control";
import { fileLeaf } from "@/lib/progress/paths";
import { summarize, type QueueSummary } from "@/lib/progress/summary";
import type { JobSnapshot } from "@/lib/progress/types";

export interface MachineBoard {
  host: "mac-local" | "pc-agent";
  label: string;
  encoder: string;
  paused: boolean;
  handbrakeSlots: number;
  handbrakeRunning: number;
  maxParallel: number;
  running: number;
  nextFile: string | null;
  userActive: boolean;
  summary: QueueSummary;
}

export interface QueueBoard {
  summary: QueueSummary;
  machines: MachineBoard[];
  load: LoadPolicy;
  queuePaused: boolean;
  hostPaused: { "mac-local": boolean; "pc-agent": boolean };
}

const MACHINES = [
  { host: "mac-local" as const, label: "Mac", encoder: "Apple VideoToolbox" },
  { host: "pc-agent" as const, label: "ПК", encoder: "AMD RX 9070 XT · VCE/AMF" },
] ;

export async function queueBoard(jobs: readonly JobSnapshot[], control?: QueueControl): Promise<QueueBoard> {
  const current = control ?? (await readControl());
  const next = await nextTranscodeFiles();
  return {
    summary: summarize(jobs),
    machines: MACHINES.map((machine) => machineBoard(machine, jobs, current, next[machine.host])),
    load: current.load,
    queuePaused: current.paused,
    hostPaused: {
      "mac-local": current.hosts["mac-local"].paused,
      "pc-agent": current.hosts["pc-agent"].paused,
    },
  };
}

function machineBoard(
  machine: { host: "mac-local" | "pc-agent"; label: string; encoder: string },
  jobs: readonly JobSnapshot[],
  control: QueueControl,
  nextFile: string | null,
): MachineBoard {
  const mine = jobs.filter((job) => snapshotHost(job.host) === machine.host);
  const running = mine.filter((job) => job.status === "running");
  return {
    host: machine.host,
    label: machine.label,
    encoder: machine.encoder,
    paused: control.paused || control.hosts[machine.host].paused,
    handbrakeSlots: control.load.handbrakeSlots[machine.host],
    handbrakeRunning: running.filter((job) => job.kind === "transcode").length,
    maxParallel: control.load.maxParallel[machine.host],
    running: running.length,
    nextFile,
    userActive: control.load.userActive[machine.host],
    summary: summarize(mine),
  };
}

async function nextTranscodeFiles(): Promise<Record<"mac-local" | "pc-agent", string | null>> {
  const out: Record<"mac-local" | "pc-agent", string | null> = { "mac-local": null, "pc-agent": null };
  try {
    const store = getJobStore();
    for (const host of ["mac-local", "pc-agent"] as const) {
      out[host] = await oldestQueuedTranscode(store, host);
    }
  } catch {
    // The board still shows the jobs that were already collected.
  }
  return out;
}

async function oldestQueuedTranscode(store: ReturnType<typeof getJobStore>, host: JobHost): Promise<string | null> {
  let last: string | null = null;
  let offset = 0;
  for (;;) {
    const page = await store.list({ host, state: "queued", offset, limit: 100 });
    for (const job of page.jobs) {
      if (job.kind === "transcode") last = fileLeaf(job.progress.currentFile || job.payload.source);
    }
    if (page.nextOffset === null) return last;
    offset = page.nextOffset;
  }
}
