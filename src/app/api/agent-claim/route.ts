import { hostFromBody, jobGuard, jobJson, publicJob, readJson } from "@/lib/jobs/http";
import { getJobStore } from "@/lib/jobs/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return jobGuard(async () => {
    const host = hostFromBody(await readJson(request));
    const job = await getJobStore().claimNext(host);
    if (!job) return new Response(null, { status: 204 });
    return jobJson({ job: publicJob(job) });
  });
}
