import { guard, json } from "@/app/api/respond";
import { loadPolicyJobs } from "@/lib/policies/jobs";

export const runtime = "nodejs";

export async function GET() {
  return guard(async () => json({ jobs: await loadPolicyJobs() }));
}
