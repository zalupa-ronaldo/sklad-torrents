import { guard, json } from "@/app/api/respond";
import { loadIndexedPaths } from "@/lib/optical/drive-catalog";
import { enqueueOptical } from "@/lib/optical/burn";
import type { IndexedPath, MediaProfile, OpticalAction } from "@/lib/optical/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as {
      action?: OpticalAction;
      profile?: MediaProfile;
      driveId?: string;
      files?: IndexedPath[];
      outputDir?: string;
      label?: string;
      locationNote?: string;
      eraseConfirmed?: boolean;
    };
    const indexed = await loadIndexedPaths();
    const known = new Map(indexed.records.map((record) => [record.path, record]));
    const files = (body.files ?? []).map((file) => {
      const catalog = known.get(file.path);
      if (!catalog) return file;
      return {
        ...file,
        diskLabel: catalog.diskLabel,
        name: catalog.name,
        kind: catalog.kind,
        size: Math.max(file.size || 0, catalog.size),
      };
    });
    const job = await enqueueOptical({
      action: body.action || "burn",
      profile: body.profile,
      driveId: body.driveId,
      files,
      outputDir: body.outputDir,
      label: body.label,
      locationNote: body.locationNote,
      eraseConfirmed: body.eraseConfirmed === true,
    });
    return json({ job }, 202);
  });
}
