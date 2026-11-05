import { json } from "@/app/api/respond";
import { errorMessage } from "@/lib/qbittorrent/errors";
import { OpticalError } from "@/lib/optical/errors";
import { enqueueArtworkJob, listOpticalJobs, presentOpticalJob, type ArtworkJobInput } from "@/lib/optical/jobs";

export const runtime = "nodejs";

export async function GET() {
  try {
    return json({ jobs: (await listOpticalJobs()).map(presentOpticalJob) });
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<ArtworkJobInput>;
    const allowMock = process.env.SKLAD_OPTICAL_ALLOW_MOCK === "1";
    const job = await enqueueArtworkJob({
      platform: body.platform ?? "linux",
      action: body.action ?? "export",
      medium: String(body.medium ?? ""),
      artworkPath: String(body.artworkPath ?? ""),
      outputPath: body.outputPath,
      dataDir: body.dataDir,
      filePosition: body.filePosition,
      volumeLabel: body.volumeLabel,
      sectors: body.sectors,
      totalSectors: body.totalSectors,
      mock: allowMock && body.mock === true,
    });
    return json(presentOpticalJob(job));
  } catch (error) {
    if (error instanceof OpticalError) {
      const status = error.code === "validation" ? 400 : error.code === "not_found" ? 404 : 500;
      return json({ error: error.message }, status);
    }
    return json({ error: errorMessage(error) }, 500);
  }
}
