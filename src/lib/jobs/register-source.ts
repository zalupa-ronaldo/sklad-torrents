import { getJobStore } from "@/lib/jobs/engine";
import { fileJobSnapshot } from "@/lib/jobs/snapshot";
import { ensureJobWorkers } from "@/lib/jobs/runtime";
import { registerJobSource } from "@/lib/progress/sources";

registerJobSource({
  id: "file-queue",
  async list() {
    ensureJobWorkers();
    const page = await getJobStore().list({ offset: 0, limit: 100 });
    return page.jobs.map(fileJobSnapshot);
  },
});
