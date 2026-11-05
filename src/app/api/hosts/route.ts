import { guard, json } from "@/app/api/respond";
import { createHost, type HostDraft } from "@/lib/qbittorrent/service";
import type { HostOs, PathPreset } from "@/lib/qbittorrent/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as Partial<HostDraft>;
    const host = await createHost({
      name: String(body.name || ""),
      baseUrl: String(body.baseUrl || ""),
      username: String(body.username || ""),
      password: String(body.password || ""),
      os: body.os as HostOs,
      pathPresets: Array.isArray(body.pathPresets) ? (body.pathPresets as PathPreset[]) : [],
    });
    return json(host, 201);
  });
}
