import { guard, json } from "@/app/api/respond";
import { addShelfGame, launchShelfGame, readShelf, returnToHdd, saveGameFirmware, saveShelfTools, wantToPlay } from "@/lib/games/shelf";
import { AppError } from "@/lib/app-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => json(await readShelf()));
}

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "want") return json(await wantToPlay(String(body.id || "")));
    if (action === "return") return json(await returnToHdd(String(body.id || "")));
    if (action === "launch") return json(await launchShelfGame(String(body.id || "")));
    if (action === "tools") return json(await saveShelfTools(body.tools));
    if (action === "firmware") return json(await saveGameFirmware(String(body.id || ""), body));
    if (action === "add") return json(await addShelfGame(body));
    throw new AppError(400, "Неизвестное действие.");
  });
}
