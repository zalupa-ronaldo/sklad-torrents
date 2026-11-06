import { json } from "@/app/api/respond";
import { browseShelf } from "@/addons/drives/service";
import { DriveError } from "@/addons/drives/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const diskId = url.searchParams.get("diskId");
    const path = url.searchParams.get("path") ?? "";
    const cursor = Number(url.searchParams.get("cursor") || "0");
    const limit = Number(url.searchParams.get("limit") || "200");
    return json(await browseShelf(diskId, path, cursor, limit));
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Обзор каталога не выполнился." }, 500);
  }
}
