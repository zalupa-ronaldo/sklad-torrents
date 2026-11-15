import { guard, json } from "@/app/api/respond";
import { pipelineView } from "@/lib/scheduler/auto-queue";
import { scheduleAutoPipeline } from "@/lib/scheduler/auto-watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => json(await pipelineView()));
}

export async function POST() {
  return guard(async () => {
    scheduleAutoPipeline();
    return json({ accepted: true, deletesSource: false });
  });
}
