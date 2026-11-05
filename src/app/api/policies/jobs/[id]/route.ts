import { guard, json } from "@/app/api/respond";
import { confirmPolicyDelete } from "@/lib/policies/jobs";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const { id } = await params;
    const body = (await request.json()) as { confirm?: boolean };
    return json({ job: await confirmPolicyDelete(id, body.confirm === true) });
  });
}
