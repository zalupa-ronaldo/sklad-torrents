import { guard, json } from "@/app/api/respond";
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
      const result = await addTorrent({
        hostId: String(form.get("hostId") || ""),
        urls: String(form.get("urls") || ""),
        savePath: String(form.get("savePath") || ""),
        paused: String(form.get("paused") || "") === "true",
        filename,
        data,
      });
      return json(result);
    }
    const body = (await request.json()) as {
      hostId?: string;
      urls?: string;
      savePath?: string;
      paused?: boolean;
    };
    const result = await addTorrent({
      hostId: String(body.hostId || ""),
      urls: typeof body.urls === "string" ? body.urls : "",
      savePath: String(body.savePath || ""),
      paused: Boolean(body.paused),
    });
    return json(result);
  });
}
