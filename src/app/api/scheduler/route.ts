import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { pauseTorrent } from "@/lib/qbittorrent/service";
import { prioritizeNext, reorderQueue, resumeRespectingDisk, tickScheduler } from "@/lib/scheduler/apply";

export const runtime = "nodejs";

export async function GET() {
  return guard(async () => {
    const tick = await tickScheduler();
    return json({ queues: tick.plan.queues });
  });
}

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as {
      action?: string;
      diskKey?: string;
      torrentKey?: string;
      hostId?: string;
      hash?: string;
    };
    if (body.action === "up" || body.action === "down") {
      const tick = await reorderQueue(String(body.diskKey || ""), String(body.torrentKey || ""), body.action);
      return json({ queues: tick.plan.queues });
    }
    if (body.action === "next") {
      const tick = await prioritizeNext(String(body.diskKey || ""), String(body.torrentKey || ""));
      return json({ queues: tick.plan.queues });
    }
    if (body.action === "pause") {
      await pauseTorrent(String(body.hostId || ""), String(body.hash || ""), { user: true });
      const tick = await tickScheduler();
      return json({
        queues: tick.plan.queues,
        notice: tick.applied.resume.length > 0 ? "На паузе. Следующая загрузка на этом диске запущена." : undefined,
      });
    }
    if (body.action === "resume") {
      const result = await resumeRespectingDisk(String(body.hostId || ""), String(body.hash || ""));
      const tick = await tickScheduler();
      return json({ queues: tick.plan.queues, notice: result.notice });
    }
    throw new QbittorrentError("validation", "Неизвестное действие.");
  });
}
