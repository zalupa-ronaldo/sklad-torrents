import { guard, json } from "@/app/api/respond";
import { getPolicyView, updatePolicy } from "@/lib/policies/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => json(await getPolicyView()));
}

export async function PUT(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as { presetId?: string; rules?: unknown };
    return json(await updatePolicy(body));
  });
}
