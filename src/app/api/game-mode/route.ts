import { guard, json } from "@/app/api/respond";
import { pushGameMode } from "@/lib/game-mode/bridge";
import { readGameMode } from "@/lib/game-mode/hub";
import { productionTorrentDeps } from "@/lib/game-mode/production";
import { parseGameMode } from "@/lib/game-mode/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(readGameMode());
}

export async function POST(request: Request) {
  return guard(async () => {
    const body = await request.json().catch(() => null);
    const mode = parseGameMode(body);
    if (!mode) return json({ error: "Нужен режим on, off или auto." }, 400);
    const deps = productionTorrentDeps();
    const view = await pushGameMode(mode, {
      ...deps,
      async post(url, payload) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Агент ПК не ответил.");
        return response.json() as Promise<unknown>;
      },
    });
    return json(view);
  });
}
