import { enqueueCompress, enqueueMove, enqueueTranscode } from "@/addons/media-games/service";

import { json, readBody, toolsGuard } from "@/app/api/tools/guard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return toolsGuard(async () => {
    const body = await readBody(request);
    const hostId = String(body.hostId || "");
    if (body.kind === "transcode") {
      const job = await enqueueTranscode({
        hostId,
        inputPath: String(body.inputPath || ""),
        outputPath: String(body.outputPath || ""),
        presetId: String(body.presetId || ""),
      });
      return json(job, 201);
    }
    if (body.kind === "move") {
      const job = await enqueueMove({
        hostId,
        name: String(body.name || ""),
        sourcePath: String(body.sourcePath || ""),
        destinationPath: String(body.destinationPath || ""),
      });
      return json(job, 201);
    }
    if (body.kind === "compress") {
      const job = await enqueueCompress({
        hostId,
        folderPath: String(body.folderPath || ""),
        algorithm: String(body.algorithm || ""),
      });
      return json(job, 201);
    }
    return json({ error: "Неизвестный тип задания." }, 400);
  });
}
