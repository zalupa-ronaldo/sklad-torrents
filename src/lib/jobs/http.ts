import { JobError } from "@/lib/jobs/errors";
import { getJobStore, toPublicJob } from "@/lib/jobs/engine";
import { JOB_HOSTS, JOB_STATES, type EnqueueInput, type Job, type JobEvent, type JobHost, type JobState, type PublicJob } from "@/lib/jobs/model";

export function jobJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function publicJob(job: Job): PublicJob {
  return toPublicJob(job);
}

export async function jobGuard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof JobError) return jobJson({ error: error.message }, statusFor(error));
    console.error(error);
    return jobJson({ error: "Не удалось обработать очередь." }, 500);
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new JobError("validation", "Нужен JSON.");
  }
}

export function enqueueFromBody(body: unknown): EnqueueInput {
  if (!body || typeof body !== "object") throw new JobError("validation", "Нужно тело запроса.");
  const record = body as Record<string, unknown>;
  return {
    kind: record.kind as EnqueueInput["kind"],
    host: record.host as EnqueueInput["host"],
    source: typeof record.source === "string" ? record.source : undefined,
    destination: typeof record.destination === "string" ? record.destination : undefined,
    diskId: typeof record.diskId === "string" ? record.diskId : undefined,
    torrentHash: typeof record.torrentHash === "string" ? record.torrentHash : undefined,
    handbrakeProfile: typeof record.handbrakeProfile === "string" ? record.handbrakeProfile : undefined,
    compactAlgorithm: typeof record.compactAlgorithm === "string" ? record.compactAlgorithm : undefined,
  };
}

export function hostFromBody(body: unknown): JobHost {
  if (!body || typeof body !== "object") throw new JobError("validation", "Укажите воркер.");
  const host = (body as { host?: unknown }).host;
  if (typeof host !== "string" || !(JOB_HOSTS as readonly string[]).includes(host)) {
    throw new JobError("validation", "Неизвестный воркер.");
  }
  return host as JobHost;
}

export function listQuery(url: URL): { offset: number; limit: number; host?: JobHost; state?: JobState; q?: string } {
  const offset = numberParam(url.searchParams.get("offset"));
  const limit = numberParam(url.searchParams.get("limit"));
  const hostParam = url.searchParams.get("host");
  const stateParam = url.searchParams.get("state");
  const q = url.searchParams.get("q") ?? undefined;
  let host: JobHost | undefined;
  let state: JobState | undefined;
  if (hostParam) {
    if (!(JOB_HOSTS as readonly string[]).includes(hostParam)) throw new JobError("validation", "Неизвестный воркер.");
    host = hostParam as JobHost;
  }
  if (stateParam) {
    if (!(JOB_STATES as readonly string[]).includes(stateParam)) throw new JobError("validation", "Неизвестное состояние.");
    state = stateParam as JobState;
  }
  return { offset: offset ?? 0, limit: limit ?? 50, host, state, q };
}

export function formatSse(event: JobEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function snapshotEvent(): Promise<JobEvent> {
  const page = await getJobStore().list({ offset: 0, limit: 1 });
  return { type: "snapshot", counts: page.counts, total: page.total };
}

function numberParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new JobError("validation", "Некорректная страница.");
  return parsed;
}

function statusFor(error: JobError): number {
  if (error.code === "validation") return 400;
  if (error.code === "not_found") return 404;
  return 409;
}
