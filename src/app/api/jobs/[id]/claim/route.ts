import { JobError } from "@/lib/jobs/errors";
import { hostFromBody, jobGuard, jobJson, publicJob, readJson } from "@/lib/jobs/http";
import { getJobStore } from "@/lib/jobs/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return jobGuard(async () => {
    const { id } = await context.params;
    const host = hostFromBody(await readJson(request));
    const result = await getJobStore().claim(id, host);
    if (!result.ok) {
      if (result.reason === "not_found") throw new JobError("not_found", "Задача не найдена.");
      return jobJson({ error: "Задачу уже забрал другой воркер.", job: result.job ? publicJob(result.job) : null }, 409);
    }
    return jobJson({ job: publicJob(result.job) });
  });
}
