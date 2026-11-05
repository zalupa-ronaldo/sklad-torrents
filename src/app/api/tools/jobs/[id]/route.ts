import { ToolsError } from "@/addons/media-games/errors";
import { confirmMove } from "@/addons/media-games/service";

import { json, readBody, toolsGuard } from "@/app/api/tools/guard";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return toolsGuard(async () => {
    const { id } = await params;
    const body = await readBody(request);
    if (body.action === "keep-source") return json(await confirmMove(id, false));
    if (body.action === "delete-source") return json(await confirmMove(id, true));
    throw new ToolsError("validation", "Неизвестное действие.");
  });
}
