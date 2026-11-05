import { guard, json } from "@/app/api/respond";
import { getShelf } from "@/addons/drives/service";
import { ensureLocalsend, saveLocalsendSettings } from "@/lib/localsend/service";
import { loadSettings, type LocalSendSettings } from "@/lib/localsend/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    await ensureLocalsend();
    const settings = await loadSettings();
    const shelf = await getShelf().catch(() => null);
    return json({
      settings,
      disks: (shelf?.disks ?? []).map((disk) => ({
        id: disk.id,
        label: disk.label,
        filesystem: disk.filesystem,
        mount: disk.mountPaths[0] || disk.lastMountPath,
        online: disk.online,
      })),
    });
  });
}

export async function PUT(request: Request) {
  return guard(async () => {
    await ensureLocalsend();
    const body = (await request.json()) as Partial<LocalSendSettings>;
    return json({ settings: await saveLocalsendSettings(body) });
  });
}
