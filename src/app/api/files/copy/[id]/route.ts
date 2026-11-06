import { json } from "@/app/api/respond";
import { cancelTransferJob, getTransferJob, registerTransferProgress } from "@/addons/drives/transfer/jobs";
import { DriveError } from "@/addons/drives/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  registerTransferProgress();
  const { id } = await context.params;
  const job = getTransferJob(id);
  if (!job) return json({ error: "Задача не найдена." }, 404);
  return json({ job });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    registerTransferProgress();
    const { id } = await context.params;
    if (!cancelTransferJob(id)) return json({ error: "Задачу нельзя отменить." }, 400);
    return json({ ok: true, job: getTransferJob(id) });
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Отмена не выполнилась." }, 500);
  }
}
