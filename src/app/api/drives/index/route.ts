import { readIndexBoard, updateIndexControl } from "@/addons/drives/index-control";
import { DriveError } from "@/addons/drives/types";
import { json } from "@/app/api/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await readIndexBoard());
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Прогресс индексации не прочитался." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string; diskId?: string; policy?: unknown };
    return json(await updateIndexControl(body));
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Команда индексации не выполнилась." }, 500);
  }
}
