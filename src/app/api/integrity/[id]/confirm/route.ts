import { guard, json } from "@/app/api/respond";
import { confirmIntegrityDelete } from "@/lib/integrity/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as { confirmed?: unknown } | null;
    const job = await confirmIntegrityDelete(decodeURIComponent(id), body?.confirmed === true);
    return json({ job, deletedFiles: false });
  });
}
