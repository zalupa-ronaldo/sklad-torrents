import { getJobStore } from "@/lib/jobs/engine";
import { enqueueFromBody, jobGuard, jobJson, listQuery, publicJob, readJson } from "@/lib/jobs/http";
import { ensureJobWorkers } from "@/lib/jobs/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return jobGuard(async () => {
    ensureJobWorkers();
    const page = await getJobStore().list(listQuery(new URL(request.url)));
    return jobJson({ ...page, jobs: page.jobs.map(publicJob) });
  });
}

export async function POST(request: Request) {
  return jobGuard(async () => {
    ensureJobWorkers();
    const result = await getJobStore().enqueue(enqueueFromBody(await readJson(request)));
    return jobJson({ job: publicJob(result.job), created: result.created }, result.created ? 201 : 200);
  });
}
