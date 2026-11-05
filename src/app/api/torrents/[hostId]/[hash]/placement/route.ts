import { guard, json } from "@/app/api/respond";
import { placementFor } from "@/lib/policies/service";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ hostId: string; hash: string }> }) {
  return guard(async () => {
    const { hostId, hash } = await params;
    return json(await placementFor(hostId, hash));
  });
}
