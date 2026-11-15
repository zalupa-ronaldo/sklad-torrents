import { guard, json } from "@/app/api/respond";
import { QbittorrentError } from "@/lib/qbittorrent/errors";
import { testHost } from "@/lib/qbittorrent/service";
import { probeChannelError } from "@/lib/service/channel";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as {
      id?: string;
      baseUrl?: string;
      username?: string;
      password?: string;
    };
    try {
      return json(await testHost(body));
    } catch (error) {
      if (error instanceof QbittorrentError && (error.code === "network" || error.code === "http")) {
        const detail = await probeChannelError({ id: body.id, baseUrl: body.baseUrl });
        if (detail) throw new QbittorrentError(error.code, detail);
      }
      throw error;
    }
  });
}
