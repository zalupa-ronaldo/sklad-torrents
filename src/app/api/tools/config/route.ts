import { saveToolsConfig } from "@/addons/media-games/service";

import { json, readBody, toolsGuard } from "@/app/api/tools/guard";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  return toolsGuard(async () => json(await saveToolsConfig(await readBody(request))));
}
