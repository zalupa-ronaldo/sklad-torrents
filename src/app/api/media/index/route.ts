import { fileIndexStatus, rebuildFileIndex } from "@/addons/media-games/file-index/service";
import { json } from "@/app/api/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json({ statuses: fileIndexStatus() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    const id = body.id === "mac-vault" || body.id === "win-games" ? body.id : "all";
    return json(await rebuildFileIndex(id));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Индекс не построился." }, 500);
  }
}
