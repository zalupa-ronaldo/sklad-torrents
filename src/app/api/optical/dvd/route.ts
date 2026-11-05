import { guard, json } from "@/app/api/respond";
import { opticalSnapshot, setDemoMode } from "@/lib/optical/burn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => json(await opticalSnapshot()));
}

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as { demo?: boolean };
    await setDemoMode(body.demo === true);
    return json(await opticalSnapshot());
  });
}
