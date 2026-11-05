import { json } from "@/app/api/respond";
import { errorMessage } from "@/lib/qbittorrent/errors";
import { listArtworkCatalog } from "@/lib/optical/jobs";

export const runtime = "nodejs";

export async function GET() {
  try {
    return json({ images: await listArtworkCatalog() });
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
}
