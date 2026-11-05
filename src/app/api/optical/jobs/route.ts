import { opticalFailure, opticalJson } from "@/app/api/optical/http";
import { AGENT_OFFLINE } from "@/lib/optical/errors";
import { enqueueArtworkJob, presentOpticalJob } from "@/lib/optical/jobs";
import { enqueueOpticalJob, listOpticalJobs } from "@/lib/optical/service";
import type { MacJobRequest, OpticalKind } from "@/lib/optical/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set<OpticalKind>([
  "list-drives",
  "media-info",
  "burn",
  "verify",
  "discimagestudio-live",
  "discimagestudio-offline",
]);

export async function GET() {
  try {
    return opticalJson({ jobs: await listOpticalJobs() });
  } catch (error) {
    return opticalFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const raw = (await request.json()) as Partial<MacJobRequest> & {
      artworkPath?: string;
      platform?: string;
      action?: string;
      medium?: string;
      dataDir?: string;
      filePosition?: string;
      outputPath?: string;
    };
    if (typeof raw.artworkPath === "string" && !raw.kind) {
      const platform = raw.platform === "darwin" || raw.platform === "win32" || raw.platform === "linux" ? raw.platform : "linux";
      const job = await enqueueArtworkJob({
        platform,
        action: raw.action === "burn" ? "burn" : "export",
        medium: raw.medium || "cd",
        artworkPath: raw.artworkPath,
        dataDir: raw.dataDir,
        filePosition: raw.filePosition === "outer" ? "outer" : "inner",
        outputPath: raw.outputPath,
      });
      return opticalJson(presentOpticalJob(job), 201);
    }
    const body = raw;
    if (!body.kind || !KINDS.has(body.kind)) {
      return opticalJson({ error: "Неизвестный тип задания." }, 400);
    }
    const job = await enqueueOpticalJob({
      kind: body.kind,
      sourcePath: body.sourcePath,
      outputPath: body.outputPath,
      driveId: body.driveId,
      eraseConfirmed: Boolean(body.eraseConfirmed),
      offlineHost: body.offlineHost,
      profile: body.profile,
      host: body.host,
    });
    if (job.status === "queued" && job.error === AGENT_OFFLINE) {
      return opticalJson({ error: AGENT_OFFLINE, job }, 503);
    }
    return opticalJson(job, 201);
  } catch (error) {
    return opticalFailure(error);
  }
}
