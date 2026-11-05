import { json } from "@/app/api/respond";
import { opticalCapabilities } from "@/lib/optical/jobs";

export const runtime = "nodejs";

export async function GET() {
  return json(opticalCapabilities());
}
