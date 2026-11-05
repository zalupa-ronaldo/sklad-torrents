import { guard, json } from "@/app/api/respond";
import { searchCatalog } from "@/lib/drive/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return guard(async () => {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const entries = await searchCatalog(query);
    return json({
      entries: entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        path: entry.path,
        size: entry.size,
        filesystem: entry.filesystem,
        os: entry.os,
        readable: Boolean(entry.localPath),
        source: entry.source,
        policy: entry.policy,
      })),
    });
  });
}
