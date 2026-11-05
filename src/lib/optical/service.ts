import { HttpWindowsAgent } from "@/lib/optical/agent-client";
import { AGENT_OFFLINE, OpticalError } from "@/lib/optical/errors";
import { buildMacOpticalJob } from "@/lib/optical/mac-controller";
import { buildHardwarePlan, claimAndExecute, mergeAgentReport } from "@/lib/optical/protocol";
import { readJobs, readStoredAgentUrl, upsertJob, writeStoredAgentUrl } from "@/lib/optical/queue";
import type { MacJobRequest, OpticalJob, OpticalKind } from "@/lib/optical/types";

const ERASABLE: ReadonlySet<OpticalKind> = new Set(["burn", "discimagestudio-live"]);

export async function listOpticalJobs(): Promise<OpticalJob[]> {
  return readJobs();
}

export async function getOpticalJob(id: string): Promise<OpticalJob> {
  const job = (await readJobs()).find((item) => item.id === id);
  if (!job) throw new OpticalError("not_found", "Задание не найдено.");
  return job;
}

export async function enqueueOpticalJob(request: MacJobRequest): Promise<OpticalJob> {
  const job = buildMacOpticalJob(request);
  await upsertJob(job);
  if (job.kind === "discimagestudio-offline") return job;
  return dispatch(job);
}

export async function confirmErase(id: string): Promise<OpticalJob> {
  const job = await getOpticalJob(id);
  if (!ERASABLE.has(job.kind)) {
    throw new OpticalError("validation", "Стирание подтверждается только для записи.");
  }
  const built = buildHardwarePlan({
    kind: job.kind === "discimagestudio-live" ? "discimagestudio-live" : "burn",
    sourcePath: job.sourcePath,
    driveId: job.driveId,
    eraseConfirmed: true,
  });
  const next: OpticalJob = {
    ...job,
    eraseConfirmed: true,
    argv: built.argv,
    plan: built.plan,
    error: null,
    status: "queued",
    updatedAt: new Date().toISOString(),
    physicalDiscBurned: false,
  };
  await upsertJob(next);
  return dispatch(next);
}

export async function retryJob(id: string): Promise<OpticalJob> {
  const job = await getOpticalJob(id);
  const next: OpticalJob = {
    ...job,
    status: "queued",
    error: null,
    burnExited: false,
    exitCode: null,
    verified: false,
    verifiedBy: null,
    updatedAt: new Date().toISOString(),
    physicalDiscBurned: false,
  };
  await upsertJob(next);
  if (next.kind === "discimagestudio-offline") return next;
  return dispatch(next);
}

function inProcessMock(): boolean {
  if (process.env.SKLAD_OPTICAL_AGENT === "offline") return false;
  if (process.env.SKLAD_OPTICAL_MOCK === "0") return false;
  return true;
}

export async function getAgentStatus(): Promise<{
  online: boolean;
  baseUrl: string | null;
  mock: boolean;
  physicalDiscBurned: false;
  error: string | null;
}> {
  const baseUrl = process.env.SKLAD_PC_AGENT_URL?.trim() || (await readStoredAgentUrl());
  if (!baseUrl) {
    if (inProcessMock()) {
      return { online: true, baseUrl: null, mock: true, physicalDiscBurned: false, error: null };
    }
    return { online: false, baseUrl: null, mock: false, physicalDiscBurned: false, error: AGENT_OFFLINE };
  }
  try {
    const health = await new HttpWindowsAgent(baseUrl).health();
    return { online: health.ok, baseUrl, mock: health.mock, physicalDiscBurned: false, error: null };
  } catch (error) {
    return {
      online: false,
      baseUrl,
      mock: false,
      physicalDiscBurned: false,
      error: error instanceof Error ? error.message : AGENT_OFFLINE,
    };
  }
}

export async function saveAgentBaseUrl(baseUrl: string): Promise<Awaited<ReturnType<typeof getAgentStatus>>> {
  const trimmed = baseUrl.trim();
  await writeStoredAgentUrl(trimmed ? trimmed : null);
  return getAgentStatus();
}

async function dispatch(job: OpticalJob): Promise<OpticalJob> {
  const url = process.env.SKLAD_PC_AGENT_URL?.trim() || (await readStoredAgentUrl());
  if (url) {
    try {
      const remote = await new HttpWindowsAgent(url).submit(job);
      const merged = mergeAgentReport(job, remote);
      await upsertJob(merged);
      return merged;
    } catch (error) {
      if (error instanceof OpticalError && error.code !== "offline" && error.code !== "not_found") throw error;
      return markOffline(job);
    }
  }
  if (!inProcessMock()) return markOffline(job);
  const remote = claimAndExecute(job, { workerHost: "pc-agent", mock: true });
  const merged = mergeAgentReport(job, remote);
  await upsertJob(merged);
  return merged;
}

async function markOffline(job: OpticalJob): Promise<OpticalJob> {
  const offline: OpticalJob = {
    ...job,
    status: "queued",
    error: AGENT_OFFLINE,
    physicalDiscBurned: false,
    updatedAt: new Date().toISOString(),
  };
  await upsertJob(offline);
  return offline;
}
