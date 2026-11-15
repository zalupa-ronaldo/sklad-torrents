import { requestDiskRescan } from "@/addons/drives/rescan";
import { DriveError } from "@/addons/drives/types";
import { json } from "@/app/api/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { diskId?: string };
    return json(await requestDiskRescan(String(body.diskId || "")), 202);
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Сканирование не запускалось." }, 500);
  }
}
