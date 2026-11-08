import { json } from "@/app/api/respond";
import { renameDisk } from "@/addons/drives/service";
import { DriveError } from "@/addons/drives/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { label?: string; reset?: boolean };
    return json(await renameDisk(id, String(body.label ?? ""), body.reset === true));
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Не удалось сохранить имя диска." }, 500);
  }
}
