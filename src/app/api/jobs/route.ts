import { listGames, publicGame } from "@/lib/games/library";
import { JobError } from "@/lib/jobs/errors";
import { getJobStore } from "@/lib/jobs/engine";
import { enqueueFromBody, jobGuard, jobJson, listQuery, publicJob, readJson } from "@/lib/jobs/http";
import { ensureJobWorkers } from "@/lib/jobs/runtime";
import { placeTranscode } from "@/lib/progress/place";
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
    const placed = placeTranscode(enqueueFromBody(await readJson(request)));
    if (!placed.ok) throw new JobError("validation", placed.error);
    const result = await getJobStore().enqueue(placed.input);
    return jobJson({ job: publicJob(result.job), created: result.created, notice: placed.notice }, 202);
  });
}
