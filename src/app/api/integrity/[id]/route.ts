import { json, guard } from "@/app/api/respond";
import { getIntegrityJob } from "@/lib/integrity/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await context.params;
    const job = await getIntegrityJob(decodeURIComponent(id));
    if (!job) return json({ error: "Задача хэша не найдена." }, 404);
    return json({ job });
  });
}
