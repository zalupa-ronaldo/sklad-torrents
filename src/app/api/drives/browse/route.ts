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
    const work = browseShelf(diskId, path, cursor, limit);
    if (diskId) return json(await work);
    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new DriveError(503, "Обзор корня не уложился во время.")), 8_000);
      }),
    ]);
    return json(result);
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Обзор каталога не выполнился." }, 500);
  }
}
