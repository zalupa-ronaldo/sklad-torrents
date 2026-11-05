import { guard, json } from "@/app/api/respond";
import { cancelIntegrity } from "@/lib/integrity/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await context.params;
    const job = await cancelIntegrity(decodeURIComponent(id));
    return json({ job });
  });
}
