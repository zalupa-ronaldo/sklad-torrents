import { guard, json } from "@/app/api/respond";
import { loadProgressPage } from "@/lib/progress/page-data";
import { ensureSchedulerLoop } from "@/lib/scheduler/apply";

export const runtime = "nodejs";

export async function GET() {
  return guard(async () => {
    ensureSchedulerLoop();
    return json(await loadProgressPage());
  });
}
