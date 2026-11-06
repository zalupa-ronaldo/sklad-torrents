import { json } from "@/app/api/respond";
import { listDestinations, registerTransferProgress } from "@/addons/drives/transfer/jobs";
import { DriveError } from "@/addons/drives/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    registerTransferProgress();
    const url = new URL(request.url);
    const diskId = url.searchParams.get("diskId");
    return json({ destinations: await listDestinations(diskId) });
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Не удалось получить назначения." }, 500);
  }
}
