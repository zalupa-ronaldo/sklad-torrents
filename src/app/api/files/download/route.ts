import { openBrowserDownload, registerTransferProgress } from "@/addons/drives/transfer/jobs";
import { DriveError } from "@/addons/drives/types";
import { json } from "@/app/api/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    registerTransferProgress();
    const url = new URL(request.url);
    const diskId = url.searchParams.get("diskId");
    const path = url.searchParams.get("path") || "";
    if (!diskId || !path) return json({ error: "Нужны diskId и path." }, 400);
    const file = await openBrowserDownload(diskId, path);
    const headers = new Headers({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "cache-control": "no-store",
      "x-sklad-source": encodeURIComponent(file.sourceDiskLabel),
    });
    if (file.size != null && Number.isFinite(file.size) && file.size > 0) {
      headers.set("content-length", String(file.size));
    }
    return new Response(file.stream, { status: 200, headers });
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Скачивание не удалось." }, 500);
  }
}
