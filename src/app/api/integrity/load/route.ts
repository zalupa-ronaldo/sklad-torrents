import { pauseTransferQueue, resumeTransferQueue } from "@/addons/drives/transfer/jobs";
import { guard, json } from "@/app/api/respond";
import { pauseIntegrityQueue, resumeIntegrityQueue } from "@/lib/integrity/engine";
import { effectiveCopyLoad, readCopyLoadPolicy, updateCopyLoadPolicy, type CopyLoadPolicy } from "@/lib/integrity/load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const policy = await readCopyLoadPolicy();
    return json({ policy, effective: effectiveCopyLoad(policy, new Date()) });
  });
}

export async function PUT(request: Request) {
  return guard(async () => {
    const previous = await readCopyLoadPolicy();
    const body = (await request.json().catch(() => null)) as Partial<CopyLoadPolicy> | null;
    const policy = await updateCopyLoadPolicy(body ?? {});
    if (policy.queuePaused && !previous.queuePaused) {
      await pauseIntegrityQueue();
      pauseTransferQueue();
    } else if (!policy.queuePaused && previous.queuePaused) {
      await resumeIntegrityQueue();
      resumeTransferQueue();
    }
    return json({ policy, effective: effectiveCopyLoad(policy, new Date()) });
  });
}
