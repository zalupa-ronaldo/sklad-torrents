import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { startTorrentTransfer } from "@/lib/qbittorrent/service";
import { dataDir } from "@/lib/qbittorrent/store";
import { listTransferJobs, loadTransferPolicy } from "@/lib/torrents/transfer";
import { registerTorrentTransferProgress } from "@/lib/torrents/transfer-progress";

export const runtime = "nodejs";

registerTorrentTransferProgress();

export async function GET() {
  return guard(async () => {
    const dir = dataDir();
    return json({ jobs: await listTransferJobs(dir), policy: await loadTransferPolicy(dir) });
  });
}

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as { hostId?: string; hash?: string; destination?: string } | null;
    if (!body || typeof body !== "object") throw new QbittorrentError("validation", "Нужны хост, хеш и каталог назначения.");
    const job = await startTorrentTransfer(String(body.hostId || ""), String(body.hash || ""), String(body.destination || ""));
    return json(job);
  });
}
