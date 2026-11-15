import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { dataDir } from "@/lib/qbittorrent/store";
import { controlTorrentTransfer, type TransferAction } from "@/lib/torrents/transfer";

export const runtime = "nodejs";

const ACTIONS = new Set<TransferAction>(["pause", "resume", "cancel", "pauseAll", "resumeAll", "cancelAll"]);

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as { action?: string; id?: string } | null;
    if (!body || typeof body !== "object" || !ACTIONS.has(body.action as TransferAction)) {
      throw new QbittorrentError("validation", "Неизвестное действие.");
    }
    const action = body.action as TransferAction;
    if (!action.endsWith("All") && !body.id) throw new QbittorrentError("validation", "Не указана задача переноса.");
    await controlTorrentTransfer(String(body.id || ""), action, dataDir());
    return json({ ok: true });
  });
}
