import { guard, json } from "@/app/api/respond";
import { parseLinkStatus } from "@/lib/progress/channel";
import { observeLink } from "@/lib/progress/control";
import { QbittorrentError } from "@/lib/qbittorrent/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stores the channel snapshot for admission. It does not resume paused work. */
export async function POST(request: Request) {
  return guard(async () => {
    const link = parseLinkStatus(await request.json());
    if (!link) throw new QbittorrentError("validation", "Неизвестный статус канала.");
    observeLink(link);
    return json({ ok: true });
  });
}
