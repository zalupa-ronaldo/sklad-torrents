import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { controlQueue } from "@/lib/progress/queue-actions";
import type { QueueScope } from "@/lib/progress/control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as { action?: unknown; scope?: unknown };
    const action = normalizeAction(body.action);
    if (!action) throw new QbittorrentError("validation", "Неизвестное действие.");
    const scope = body.action === "pause-all" || body.action === "resume-all" || body.action === "cancel-all" ? "all" : parseScope(body.scope);
    const result = await controlQueue(action, scope);
    return json({ ok: true, ...result });
  });
}

function normalizeAction(value: unknown): "pause" | "resume" | "cancel" | null {
  if (value === "pause" || value === "pause-all") return "pause";
  if (value === "resume" || value === "resume-all") return "resume";
  if (value === "cancel" || value === "cancel-all") return "cancel";
  return null;
}

function parseScope(value: unknown): QueueScope {
  if (value === "all" || value === "mac-local" || value === "pc-agent") return value;
  throw new QbittorrentError("validation", "Неизвестная очередь.");
}
