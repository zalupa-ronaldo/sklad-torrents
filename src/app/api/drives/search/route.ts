import { json } from "@/app/api/respond";
import { searchShelf } from "@/addons/drives/service";
import { DriveError } from "@/addons/drives/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return json(await searchShelf(query));
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Поиск по полке не выполнился." }, 500);
  }
}
