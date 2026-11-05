import { guard, json } from "@/app/api/respond";
import { resetDemo } from "@/lib/qbittorrent/service";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    await resetDemo(id);
    return json({ ok: true });
  });
}
