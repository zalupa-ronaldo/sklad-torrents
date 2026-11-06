import { json } from "@/app/api/respond";
import { enqueueCopy, getTransferJob, listTransferJobs, registerTransferProgress } from "@/addons/drives/transfer/jobs";
import { DriveError } from "@/addons/drives/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  registerTransferProgress();
  return json({ jobs: listTransferJobs() });
}

export async function POST(request: Request) {
  try {
    registerTransferProgress();
    const body = (await request.json()) as { diskId?: string; path?: string; destinationId?: string };
    if (!body.diskId || !body.path || !body.destinationId) {
      return json({ error: "Нужны diskId, path и destinationId." }, 400);
    }
    const job = await enqueueCopy({ diskId: body.diskId, path: body.path, destinationId: body.destinationId });
    return json({ job });
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Копирование не запустилось." }, 500);
  }
}
