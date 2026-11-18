import { json } from "@/app/api/respond";
import { pullAv1Status } from "@/lib/transcode/av1-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(await pullAv1Status());
}
