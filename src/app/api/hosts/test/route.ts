import { guard, json } from "@/app/api/respond";
import { testHost } from "@/lib/qbittorrent/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as {
      id?: string;
      baseUrl?: string;
      username?: string;
      password?: string;
    };
    return json(await testHost(body));
  });
}
