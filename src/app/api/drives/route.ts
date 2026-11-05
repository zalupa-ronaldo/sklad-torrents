import { json } from "@/app/api/respond";
import { getShelf } from "@/addons/drives/service";
import { DriveError } from "@/addons/drives/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await getShelf());
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Полка дисков не ответила." }, 500);
  }
}
