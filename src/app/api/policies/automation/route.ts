import { guard, json } from "@/app/api/respond";
import { setAutomationEnabled } from "@/lib/policies/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as { enabled?: boolean; fingerprint?: string };
    return json(await setAutomationEnabled(Boolean(body.enabled), String(body.fingerprint || "")));
  });
}
