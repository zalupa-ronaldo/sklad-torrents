import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { dataDir } from "@/lib/qbittorrent/store";
import { saveTransferPolicy, type TransferPolicy } from "@/lib/torrents/transfer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as Partial<TransferPolicy> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new QbittorrentError("validation", "Нужны настройки переноса.");
    }
    const patch: Partial<TransferPolicy> = {};
    if ("busy" in body) patch.busy = body.busy;
    if ("maxBytesPerSecond" in body) patch.maxBytesPerSecond = body.maxBytesPerSecond;
    if ("maxParallel" in body) patch.maxParallel = body.maxParallel;
    if ("chunkBytes" in body) patch.chunkBytes = body.chunkBytes;
    if ("schedule" in body) patch.schedule = body.schedule ?? null;
    return json(await saveTransferPolicy(dataDir(), patch));
  });
}
