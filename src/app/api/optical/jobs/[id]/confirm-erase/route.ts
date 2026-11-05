import { opticalFailure, opticalJson } from "@/app/api/optical/http";
import { AGENT_OFFLINE } from "@/lib/optical/errors";
import { confirmErase } from "@/lib/optical/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const job = await confirmErase(id);
    if (job.status === "queued" && job.error === AGENT_OFFLINE) {
      return opticalJson({ error: AGENT_OFFLINE, job }, 503);
    }
    return opticalJson(job);
  } catch (error) {
    return opticalFailure(error);
  }
}
