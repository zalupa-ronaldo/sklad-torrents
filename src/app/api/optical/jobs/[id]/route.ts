import { opticalFailure, opticalJson } from "@/app/api/optical/http";
import { getOpticalJob } from "@/lib/optical/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return opticalJson(await getOpticalJob(id));
  } catch (error) {
    return opticalFailure(error);
  }
}
