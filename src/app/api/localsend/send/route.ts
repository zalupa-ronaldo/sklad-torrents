import { guard, json } from "@/app/api/respond";
import { ensureLocalsend, enqueueSend } from "@/lib/localsend/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return guard(async () => {
    await ensureLocalsend();
    const body = (await request.json()) as {
      fingerprint?: string;
      entryIds?: string[];
      pin?: string;
      driveFiles?: { diskId?: string; path?: string; name?: string; kind?: string }[];
    };
    const result = await enqueueSend({
      fingerprint: String(body.fingerprint || ""),
      entryIds: Array.isArray(body.entryIds) ? body.entryIds.map(String) : [],
      pin: typeof body.pin === "string" ? body.pin : undefined,
      driveFiles: Array.isArray(body.driveFiles)
        ? body.driveFiles.map((file) => ({
            diskId: String(file.diskId || ""),
            path: String(file.path || ""),
            name: String(file.name || ""),
            kind: file.kind,
          }))
        : [],
    });
    return json(result);
  });
}
