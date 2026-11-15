import { opticalFailure, opticalJson } from "@/app/api/optical/http";
import {
  cancelOpticalJob,
  pauseOpticalJob,
  pauseOpticalQueue,
  resumeOpticalJob,
  resumeOpticalQueue,
} from "@/lib/optical/control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string; id?: string };
    const action = body.action;
    const id = typeof body.id === "string" ? body.id : "";
    if (action === "pause-queue") {
      await pauseOpticalQueue();
      return opticalJson({ ok: true });
    }
    if (action === "resume-queue") {
      await resumeOpticalQueue();
      return opticalJson({ ok: true });
    }
    if (!id) return opticalJson({ error: "Нужен идентификатор задачи." }, 400);
    if (action === "pause") return opticalJson(await pauseOpticalJob(id));
    if (action === "resume") return opticalJson(await resumeOpticalJob(id));
    if (action === "cancel") return opticalJson(await cancelOpticalJob(id));
    return opticalJson({ error: "Неизвестное действие." }, 400);
  } catch (error) {
    return opticalFailure(error);
  }
}
