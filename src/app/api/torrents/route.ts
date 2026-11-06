import { guard, json } from "@/app/api/respond";
import { markManaged } from "@/lib/policies/auto-managed";
import { inboxPathForHost, safeTickAutomaticPlacement } from "@/lib/policies/auto-runner";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { addTorrent } from "@/lib/qbittorrent/service";
import { ensureSchedulerLoop, tickScheduler } from "@/lib/scheduler/apply";

export const runtime = "nodejs";

export async function GET() {
  return guard(async () => {
    ensureSchedulerLoop();
    const tick = await tickScheduler();
    return json(tick.dashboard);
  });
}

async function resolveSavePath(hostId: string, requested: string): Promise<string> {
  const trimmed = requested.trim();
  if (trimmed) return trimmed;
  return inboxPathForHost(hostId);
}

async function afterAdd(hostId: string, hashes: string[]): Promise<void> {
  for (const hash of hashes) {
    if (hash) await markManaged(hostId, hash);
  }
  void safeTickAutomaticPlacement();
}

export async function POST(request: Request) {
  return guard(async () => {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("torrent");
      let data: Uint8Array | undefined;
      let filename: string | undefined;
      if (file instanceof File && file.size > 0) {
        if (file.size > 20 * 1024 * 1024) {
          throw new QbittorrentError("validation", "Файл .torrent больше 20 МБ.");
        }
        data = new Uint8Array(await file.arrayBuffer());
        filename = file.name;
      }
      const hostId = String(form.get("hostId") || "");
      const savePath = await resolveSavePath(hostId, String(form.get("savePath") || ""));
      const result = await addTorrent({
        hostId,
        urls: String(form.get("urls") || ""),
        savePath,
        paused: String(form.get("paused") || "") === "true",
        filename,
        data,
      });
      await afterAdd(hostId, result.hashes);
      return json(result);
    }
    const body = (await request.json()) as {
      hostId?: string;
      urls?: string;
      savePath?: string;
      paused?: boolean;
    };
    const hostId = String(body.hostId || "");
    const savePath = await resolveSavePath(hostId, String(body.savePath || ""));
    const result = await addTorrent({
      hostId,
      urls: typeof body.urls === "string" ? body.urls : "",
      savePath,
      paused: Boolean(body.paused),
    });
    await afterAdd(hostId, result.hashes);
    return json(result);
  });
}
