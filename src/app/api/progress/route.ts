import { guard, json } from "@/app/api/respond";
import { getProgressPayload } from "@/lib/progress/jobs";
import { ensureSchedulerLoop } from "@/lib/scheduler/apply";

export const runtime = "nodejs";

export async function GET() {
  return guard(async () => {
    ensureSchedulerLoop();
    return json(await getProgressPayload());
  });
}
