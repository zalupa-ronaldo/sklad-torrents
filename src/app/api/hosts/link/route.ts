import { guard, json } from "@/app/api/respond";
import { tickChannel } from "@/lib/service/channel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => json(await tickChannel()));
}
