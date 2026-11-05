import { json } from "@/app/api/respond";
import { ingestObservation } from "@/addons/drives/service";
import { DriveError, type HostObservation } from "@/addons/drives/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { observation?: HostObservation };
    const observation = body.observation;
    if (!observation || (observation.os !== "darwin" && observation.os !== "win32") || !Array.isArray(observation.volumes)) {
      throw new DriveError(400, "Нужно событие агента с полем observation.");
    }
    return json(
      await ingestObservation({
        hostId: String(observation.hostId || "mock-host"),
        hostName: String(observation.hostName || "Демо"),
        os: observation.os,
        elevated: observation.elevated === true,
        volumes: observation.volumes,
      }),
    );
  } catch (error) {
    if (error instanceof DriveError) return json({ error: error.message }, error.status);
    return json({ error: "Демо-событие не принято." }, 500);
  }
}
