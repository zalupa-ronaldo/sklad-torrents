import { actionRoute } from "@/lib/jobs/action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return actionRoute(id, (store, jobId) => store.resume(jobId));
}
