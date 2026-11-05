import { guard, json } from "@/app/api/respond";
import { addManualDevice, ensureLocalsend, localsendStatus } from "@/lib/localsend/service";
import { LOCALSEND_PORT } from "@/lib/localsend/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    await ensureLocalsend();
    return json(await localsendStatus());
  });
}

export async function POST(request: Request) {
  return guard(async () => {
    await ensureLocalsend();
    const body = (await request.json()) as { address?: string; port?: number };
    const device = await addManualDevice(String(body.address || ""), Number(body.port || LOCALSEND_PORT));
    return json({ device });
  });
}
