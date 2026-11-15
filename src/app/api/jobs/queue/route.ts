import { guard, json } from "@/app/api/respond";
import { POST as progressQueue } from "@/app/api/progress/queue/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Same whole-queue commands as the progress panel: pause-all, resume-all, cancel-all. */
export async function POST(request: Request) {
  return guard(async () => progressQueue(request));
}

export async function GET() {
  return guard(async () => {
    const { readControl, toLoadContract } = await import("@/lib/progress/control");
    const control = await readControl();
    return json(toLoadContract(control));
  });
}
