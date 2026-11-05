import { searchFileIndex } from "@/addons/media-games/file-index/service";
import { json } from "@/app/api/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").slice(0, 200);
  const volume = url.searchParams.get("volume") || undefined;
  const directoriesOnly = url.searchParams.get("directories") === "1";
  try {
    const hits = await searchFileIndex(query, { volume, directoriesOnly });
    return json({ hits });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Поиск не удался." }, 500);
  }
}
