import { jobGuard, jobJson, publicJob } from "@/lib/jobs/http";
import { getJobStore } from "@/lib/jobs/engine";
import { JobError } from "@/lib/jobs/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return jobGuard(async () => {
    const { id } = await context.params;
    const job = await getJobStore().get(id);
    if (!job) throw new JobError("not_found", "Задача не найдена.");
    return jobJson({ job: publicJob(job) });
  });
}
