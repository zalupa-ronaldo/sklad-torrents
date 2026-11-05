import { jobGuard, jobJson, publicJob } from "@/lib/jobs/http";
import { getJobStore, type JobStore } from "@/lib/jobs/engine";
import type { Job } from "@/lib/jobs/model";

export function actionRoute(id: string, fn: (store: JobStore, id: string) => Promise<Job>) {
  return jobGuard(async () => {
    const job = await fn(getJobStore(), id);
    return jobJson({ job: publicJob(job) });
  });
}
