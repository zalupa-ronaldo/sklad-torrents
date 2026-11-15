import { actionRoute } from "@/lib/jobs/action";
import { getJobStore } from "@/lib/jobs/engine";
import { jobJson } from "@/lib/jobs/http";
import { resumeRefusal } from "@/lib/progress/control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await getJobStore().get(id);
  const message = job ? await resumeRefusal(job.host) : null;
  if (message) return jobJson({ error: message }, 409);
  return actionRoute(id, (store, jobId) => store.resume(jobId));
}
