import { guard, json } from "@/app/api/respond";
import { ensureLocalsend } from "@/lib/localsend/service";
import { listTransfers } from "@/lib/localsend/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    await ensureLocalsend();
    return json({ transfers: await listTransfers() });
  });
}
