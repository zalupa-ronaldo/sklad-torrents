import { hostFromBody, jobGuard, jobJson, publicJob, readJson } from "@/lib/jobs/http";
import { getJobStore } from "@/lib/jobs/engine";
import { applyHeartbeat, parseChannelBody } from "@/lib/service/channel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return jobGuard(async () => {
    const body = await readJson(request);
    const heartbeat = parseChannelBody(body);
    if (heartbeat) {
      const result = await applyHeartbeat(heartbeat);
      return jobJson({ ok: true, link: result.link, actions: result.actions });
    }
    const host = hostFromBody(body);
    const job = await getJobStore().claimNext(host);
    if (!job) return new Response(null, { status: 204 });
    return jobJson({ job: publicJob(job) });
  });
}
