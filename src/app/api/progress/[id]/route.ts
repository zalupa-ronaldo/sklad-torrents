import { guard, json } from "@/app/api/respond";
import { resumeRefusal, snapshotHost } from "@/lib/progress/control";
import { getJob, performJobAction } from "@/lib/progress/jobs";
import { QbittorrentError } from "@/lib/qbittorrent/errors";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const job = await getJob(id);
    if (!job) throw new QbittorrentError("not_found", "Операция не найдена.");
    return json({ job });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const body = (await request.json()) as { action?: string };
    if (body.action !== "pause" && body.action !== "resume" && body.action !== "cancel") {
      throw new QbittorrentError("validation", "Неизвестное действие.");
    }
    if (body.action === "resume") {
      const existing = await getJob(id);
      const message = await resumeRefusal(snapshotHost(existing?.host ?? null));
      if (message) throw new QbittorrentError("validation", message);
    }
    const result = await performJobAction(id, body.action);
    if (body.action === "pause") {
      const paused = await getJob(id);
      if (paused?.kind === "transcode" && !result.notice) {
        result.notice = "Пауза по файлам. Частичный результат не заменяет оригинал.";
      }
    }
    return json({ ok: true, ...result });
  });
}
