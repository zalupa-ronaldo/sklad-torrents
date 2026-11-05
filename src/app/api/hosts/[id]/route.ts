import { guard, json } from "@/app/api/respond";
import { deleteHost, updateHost, type HostDraft } from "@/lib/qbittorrent/service";
import type { HostOs, PathPreset } from "@/lib/qbittorrent/types";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const body = (await request.json()) as Partial<HostDraft>;
    const host = await updateHost(id, {
      name: String(body.name || ""),
      baseUrl: String(body.baseUrl || ""),
      username: String(body.username || ""),
      password: typeof body.password === "string" ? body.password : "",
      os: body.os as HostOs,
      pathPresets: Array.isArray(body.pathPresets) ? (body.pathPresets as PathPreset[]) : [],
    });
    return json(host);
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    await deleteHost(id);
    return json({ ok: true });
  });
}
