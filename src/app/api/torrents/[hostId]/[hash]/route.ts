import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import {
  deleteTorrent,
  getTorrentDetail,
  markForMove,
  pauseTorrent,
  relocateTorrent,
  setFilePriority,
  skipIncomplete,
  unmarkMove,
} from "@/lib/qbittorrent/service";
import { resumeRespectingDisk, tickScheduler } from "@/lib/scheduler/apply";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ hostId: string; hash: string }> }) {
  return guard(async () => {
    const { hostId, hash } = await params;
    return json(await getTorrentDetail(hostId, hash));
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ hostId: string; hash: string }> }) {
  return guard(async () => {
    const { hostId, hash } = await params;
    const body = (await request.json()) as {
      action?: string;
      deleteFiles?: boolean;
      location?: string;
      destination?: string;
      ids?: number[];
      priority?: number;
    };
    switch (body.action) {
      case "pause": {
        await pauseTorrent(hostId, hash, { user: true });
        const tick = await tickScheduler();
        return json({
          ok: true,
          notice: tick.applied.resume.length > 0 ? "На паузе. Следующая загрузка на этом диске запущена." : undefined,
        });
      }
      case "resume": {
        const result = await resumeRespectingDisk(hostId, hash);
        return json({ ok: true, notice: result.notice });
      }
      case "delete":
        await deleteTorrent(hostId, hash, Boolean(body.deleteFiles));
        return json({ ok: true });
      case "location":
        await relocateTorrent(hostId, hash, String(body.location || ""));
        return json({ ok: true });
      case "mark":
        await markForMove(hostId, hash, String(body.destination || ""));
        return json({ ok: true });
      case "unmark":
        await unmarkMove(hostId, hash);
        return json({ ok: true });
      case "priority":
        await setFilePriority(hostId, hash, body.ids || [], Number(body.priority));
        return json({ ok: true });
      case "skip-incomplete": {
        const result = await skipIncomplete(hostId, hash);
        return json(result);
      }
      default:
        throw new QbittorrentError("validation", "Неизвестное действие.");
    }
  });
}
