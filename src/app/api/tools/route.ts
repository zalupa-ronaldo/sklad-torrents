import { getToolsSnapshot } from "@/addons/media-games/service";

import { json, toolsGuard } from "@/app/api/tools/guard";

export const runtime = "nodejs";

export async function GET() {
  return toolsGuard(async () => json(await getToolsSnapshot()));
}
