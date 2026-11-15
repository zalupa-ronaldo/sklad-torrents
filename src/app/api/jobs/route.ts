import { listGames, publicGame } from "@/lib/games/library";
import { getJobStore } from "@/lib/jobs/engine";
import { enqueueFromBody, jobGuard, jobJson, listQuery, publicJob, readJson } from "@/lib/jobs/http";
import { ensureJobWorkers } from "@/lib/jobs/runtime";
import { dataDir } from "@/lib/qbittorrent/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return jobGuard(async () => {
    ensureJobWorkers();
    const page = await getJobStore().list(listQuery(new URL(request.url)));
    const games = (await listGames(dataDir())).map(publicGame);
    return jobJson({ ...page, jobs: page.jobs.map(publicJob), games });
  });
}

export async function POST(request: Request) {
  return jobGuard(async () => {
    ensureJobWorkers();
    const result = await getJobStore().enqueue(enqueueFromBody(await readJson(request)));
    return jobJson({ job: publicJob(result.job), created: result.created }, 202);
  });
}
