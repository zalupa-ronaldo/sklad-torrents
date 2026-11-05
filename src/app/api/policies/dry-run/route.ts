import { guard, json } from "@/app/api/respond";
import { runPreview } from "@/lib/policies/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return guard(async () => json(await runPreview()));
}
