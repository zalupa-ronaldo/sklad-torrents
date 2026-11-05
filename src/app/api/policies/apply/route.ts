import { guard, json } from "@/app/api/respond";
import { applyPolicyPass } from "@/lib/policies/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as { fingerprint?: string };
    return json(await applyPolicyPass(String(body.fingerprint || "")));
  });
}
