import { readVolumeCompact, startVolumeCompact } from "@/addons/drives/compact-service";
import { DriveError } from "@/addons/drives/types";
import { json } from "@/app/api/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { diskId?: string; path?: string; algorithm?: string; confirm?: boolean };
    const job = await startVolumeCompact({
      diskId: String(body.diskId || ""),
      relativePath: String(body.path || ""),
      algorithm: String(body.algorithm || ""),
      confirm: body.confirm === true,
    });
    return json(job, job.state === "failed" ? 502 : 202);
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Сжатие не запускалось." }, 500);
  }
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    return json(await readVolumeCompact(id));
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Статус сжатия недоступен." }, 500);
  }
}
