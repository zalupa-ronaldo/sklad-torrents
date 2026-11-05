import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { getJob, performJobAction } from "@/lib/progress/jobs";

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
    const result = await performJobAction(id, body.action);
    return json({ ok: true, ...result });
  });
}
