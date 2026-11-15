import { guard, json } from "@/app/api/respond";
import { readControl } from "@/lib/progress/control";
import { saveLoad } from "@/lib/progress/queue-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => json({ load: (await readControl()).load, queuePaused: (await readControl()).paused }));
}

export async function POST(request: Request) {
  return guard(async () => {
    const body = await request.json();
    const load = await saveLoad(body);
    return json({ load });
  });
}
