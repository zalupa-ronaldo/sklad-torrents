import { guard, json } from "@/app/api/respond";
import { runPreview } from "@/lib/policies/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json().catch(() => ({}))) as { rules?: unknown };
    return json(await runPreview(body.rules));
  });
}
